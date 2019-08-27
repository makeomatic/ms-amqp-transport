// deps
const Promise = require('bluebird');
const gunzip = Promise.promisify(require('zlib').gunzip);
const gzip = Promise.promisify(require('zlib').gzip);
const uuid = require('uuid');
const flatstr = require('flatstr');
const stringify = require('json-stringify-safe');
const EventEmitter = require('eventemitter3');
const os = require('os');
const is = require('is');
const assert = require('assert');
const opentracing = require('opentracing');
const {
  ConnectionError,
  NotPermittedError,
  ValidationError,
  InvalidOperationError,
  ArgumentError,
} = require('common-errors');

// lodash fp
const merge = require('lodash/merge');
const defaults = require('lodash/defaults');
const noop = require('lodash/noop');
const uniq = require('lodash/uniq');
const extend = require('lodash/extend');
const pick = require('lodash/pick');
const set = require('lodash/set');

// local deps
const Joi = require('@hapi/joi');
const schema = require('./schema');
const pkg = require('../package.json');
const AMQP = require('./utils/transport');
const ReplyStorage = require('./utils/reply-storage');
const Backoff = require('./utils/recovery');
const Cache = require('./utils/cache');
const latency = require('./utils/latency');
const loggerUtils = require('./loggers');
const generateErrorMessage = require('./utils/error');
const helpers = require('./helpers');
const { kReplyHeaders } = require('./constants');

// serialization functions
const { jsonSerializer, jsonDeserializer } = require('./utils/serialization');

// cache references
const { AmqpDLXError } = generateErrorMessage;
const { closeConsumer, wrapError, setQoS } = helpers;
const { Tags, FORMAT_TEXT_MAP } = opentracing;
const PARSE_ERR = new ValidationError('couldn\'t deserialize input', 500, 'message.raw');

// wrap promise
const wrapPromise = (span, promise) => (
  Promise
    .resolve(promise)
    .catch((error) => {
      span.setTag(Tags.ERROR, true);
      span.log({
        event: 'error',
        'error.object': error,
        message: error.message,
        stack: error.stack,
      });

      return Promise.reject(error);
    })
    .finally(() => {
      span.finish();
    })
);

const serialize = async (message, publishOptions) => {
  let serialized;
  switch (publishOptions.contentType) {
    case 'application/json':
    case 'string/utf8':
      serialized = Buffer.from(flatstr(stringify(message, jsonSerializer)));
      break;

    default:
      throw new Error('invalid content-type');
  }

  if (publishOptions.contentEncoding === 'gzip') {
    return gzip(serialized);
  }

  return serialized;
};

function safeJSONParse(data, log) {
  try {
    return JSON.parse(data, jsonDeserializer);
  } catch (err) {
    log.warn('Error parsing buffer', err, String(data));
    return { err: PARSE_ERR };
  }
}

const toUniqueStringArray = routes => (
  Array.isArray(routes) ? uniq(routes) : [routes]
);

/**
 * Routing function HOC with reply RPC enhancer
 * @param  {Function} messageHandler
 * @param  {AMQPTransport} transport
 * @returns {Function}
 */
const initRoutingFn = (messageHandler, transport) => {
  /**
   * Response Handler Function. Sends Reply or Noop log.
   * @param  {AMQPMessage} raw - Raw AMQP Message Structure
   * @param  {Error} error - Error if it happened.
   * @param  {mixed} data - Response data.
   * @returns {Promise<*>}
   */
  function responseHandler(raw, error, data) {
    const { properties, span } = raw;
    return !properties.replyTo || !properties.correlationId
      ? transport.noop(error, data, span, raw)
      : transport.reply(properties, { error, data }, span, raw);
  }

  /**
   * Initiates consumer message handler.
   * @param  {mixed} message - Data passed from the publisher.
   * @param  {Object} properties - AMQP Message properties.
   * @param  {Object} raw - Original AMQP message.
   * @param  {Function} [raw.ack] - Acknowledge if nack is `true`.
   * @param  {Function} [raw.reject] - Reject if nack is `true`.
   * @param  {Function} [raw.retry] - Retry msg if nack is `true`.
   * @returns {Void}
   */
  return function router(message, properties, raw) {
    // add instrumentation
    const appId = safeJSONParse(properties.appId, this.log);

    // opentracing instrumentation
    const childOf = this.tracer.extract(FORMAT_TEXT_MAP, properties.headers || {});
    const span = this.tracer.startSpan(`onConsume:${properties.routingKey}`, {
      childOf,
    });

    span.addTags({
      [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
      [Tags.PEER_SERVICE]: appId.name,
      [Tags.PEER_HOSTNAME]: appId.host,
    });

    // define span in the original message
    // so that userland has access to it
    raw.span = span;

    return messageHandler(message, properties, raw, responseHandler.bind(undefined, raw));
  };
};

/**
 * @param {Object} response
 * @oaram {Object} response.data
 * @oaram {Object} response.headers
 * @param {Object} replyOptions
 * @param {boolean} replyOptions.simpleResponse
 * @returns {Object}
 */
function adaptResponse(response, replyOptions) {
  return replyOptions.simpleResponse === false ? response : response.data;
}

/**
 * @param {mixed} message
 * @param {Object} message.data
 * @param {Object} message.error
 * @param {Object} properties
 * @param {Object} properties.headers
 */
function buildResponse(message, properties) {
  const { headers } = properties;
  const { data } = message;

  return {
    headers,
    data,
  };
}

/**
 * @class AMQPTransport
 */
class AMQPTransport extends EventEmitter {
  static extendMessageProperties = [
    'deliveryTag',
    'redelivered',
    'exchange',
    'routingKey',
    'weight',
  ];

  static error406 = { replyCode: 406 };

  /**
   * Instantiate AMQP Transport
   * @param  {Object} opts, defaults to {}
   */
  constructor(opts = {}) {
    super();

    // prepare configuration
    const validateResult = Joi.validate(opts, schema, {
      allowUnknown: true,
    });

    // verify that there was no error
    assert.ifError(validateResult.error);
    const config = this.config = validateResult.value;

    // prepares logger
    this.log = loggerUtils.prepareLogger(config);

    // init cache or pass-through operations
    this.cache = new Cache(config.cache);

    // reply storage, where we'd save correlation ids
    // and callbacks to be called once we are done
    this.replyStorage = new ReplyStorage();

    // delay settings for reconnect
    this.recovery = new Backoff(config.recovery);

    // init open tracer - default one is noop
    this.tracer = config.tracer || new opentracing.Tracer();

    // setup instance
    this._replyTo = null;
    this._consumers = new WeakMap();
    this._queues = new WeakMap();
    this._boundEmit = this.emit.bind(this);
    this.consumers = new Map();
    this._boundRegisterConsumer = this._registerConsumer.bind(this);

    // Form app id string for debugging
    this._appID = {
      name: this.config.name,
      host: os.hostname(),
      pid: process.pid,
      utils_version: pkg.version,
      version: opts.version || 'n/a',
    };

    // Cached serialized value
    this._appIDString = stringify(this._appID);
    this._defaultOpts = { ...config.defaultOpts };
    this._defaultOpts.appId = this._appIDString;
    this._extraQueueOptions = {};

    // DLX config
    if (config.dlx.enabled === true) {
      // there is a quirk - we must make sure that no routing key matches queue name
      // to avoid useless redistributions of the message
      this._extraQueueOptions.arguments = { 'x-dead-letter-exchange': config.dlx.params.exchange };
    }
  }

  /**
   * Connects to AMQP, if config.router is specified earlier,
   * automatically invokes .consume function
   * @return {Promise}
   */
  connect() {
    const { _amqp: amqp, config } = this;

    if (amqp) {
      switch (amqp.state) {
        case 'opening':
        case 'open':
        case 'reconnecting': {
          const msg = 'connection was already initialized, close it first';
          const err = new InvalidOperationError(msg);
          return Promise.reject(err);
        }

        default:
          // already closed, but make sure
          amqp.close();
          this._amqp = null;
      }
    }

    return Promise
      .fromNode((next) => {
        this._amqp = new AMQP(config.connection, next);
        this._amqp.on('ready', this._onConnect);
        this._amqp.on('close', this._onClose);
      })
      .return(this);
  }

  /**
   * Noop function with empty correlation id and reply to data
   * @param  {Error} error
   * @param  {mixed} data
   * @param  {Span}  [span]
   * @param  {AMQPMessage} [raw]
   */
  noop(error, data, span, raw) {
    const msg = stringify({ error, data }, jsonSerializer);
    this.log.debug('when replying to message with %s response could not be delivered', msg);

    if (span !== undefined) {
      if (error) {
        span.setTag(Tags.ERROR, true);
        span.log({
          event: 'error', 'error.object': error, message: error.message, stack: error.stack,
        });
      }

      span.finish();
    }

    if (raw !== undefined) {
      this.emit('after', raw);
    }
  }

  /**
   * Stops consumers and closes transport
   */
  async _close() {
    const { _amqp: amqp } = this;

    await this.stopConsumers();

    try {
      await new Promise((resolve, reject) => {
        amqp.once('close', resolve);
        amqp.once('error', reject);
        amqp.close();
      });
    } finally {
      this._amqp = null;
      amqp.removeAllListeners();
    }
  }

  close() {
    const { _amqp: amqp } = this;
    if (amqp) {
      switch (amqp.state) {
        case 'opening':
        case 'open':
        case 'reconnecting':
          return this._close();
        default:
          this._amqp = null;
          return Promise.resolve();
      }
    }

    const err = new InvalidOperationError('connection was not initialized in the first place');
    return Promise.reject(err);
  }

  /**
   * Create queue with specified settings in current connection
   * also emit new event on message in queue
   *
   * @param {Object}  opts   - queue parameters
   */
  createQueue(opts) {
    const { _amqp: amqp, log, _onConsume } = this;

    // prepare params
    const ctx = {};
    const userParams = is.string(opts) ? { queue: opts } : opts;
    const queueName = userParams.queue;
    const params = merge({ autoDelete: !queueName, durable: !!queueName }, userParams);

    log.debug('initializing queue', params);

    return Promise
      .bind(ctx, amqp)
      .call('queueAsync', params)
      .then(function declareQueue(queue) {
        this.queue = queue;
        return queue.declareAsync();
      })
      .catch(AMQPTransport.error406, this._on406.bind(this, params))
      .catch((err) => {
        log.warn('failed to init queue', params.queue, err.replyText);
        throw err;
      })
      .then(function establishConsumer() {
        // copy queue options
        const options = this.options = { ...this.queue.queueOptions };
        log.info('queue "%s" created', options.queue);

        if (!params.router) {
          return null;
        }

        return Promise.fromNode((next) => {
          log.info('consumer is being created on "%s"', options.queue);

          // setup consumer
          this.consumer = amqp.consume(
            options.queue,
            setQoS(params),
            _onConsume(params.router),
            next
          );
        });
      })
      .return(ctx);
  }

  /**
   * Create unnamed private queue (used for reply events)
   */
  createPrivateQueue(attempt = 0) {
    const replyTo = this._replyTo;

    // reset current state
    this._replyTo = false;

    return Promise
      .bind(this, this)
      .delay(this.recovery.get('private', attempt))
      .call('createQueue', {
        ...this.config.privateQueueOpts,
        // private router here
        router: this._privateMessageRouter,
        // reuse same private queue name if it was specified before
        queue: replyTo || `microfleet.${uuid.v4()}`,
      })
      .then(function privateQueueCreated(data) {
        const { consumer, queue, options } = data;

        // remove existing listeners
        consumer.removeAllListeners('error');
        consumer.removeAllListeners('cancel');

        // consume errors - re-create when we encounter 404
        consumer.on('error', (err) => {
          const { error } = err;
          if (error && error.replyCode === 404 && error.replyText.indexOf(options.queue) !== -1) {
            // https://github.com/dropbox/amqp-coffee#consumer-event-error
            // handle consumer error on reconnect and close consumer
            // warning: other queues (not private one) should be handled manually
            this.log.error('consumer returned 404 error', error);

            // reset replyTo queue and ignore all future errors
            consumer.removeAllListeners('error');
            consumer.removeAllListeners('cancel');
            consumer.on('error', noop);
            consumer.close();

            // recreate queue
            if (this._replyTo !== false) this.createPrivateQueue();

            return null;
          }

          this.log.error('private consumer returned err', err);
          this.emit('error', err);
          return null;
        });

        // re-create on cancel as-well
        consumer.once('cancel', () => {
          consumer.removeAllListeners('error');
          consumer.removeAllListeners('cancel');
          consumer.on('error', noop);
          consumer.close();

          // recreate queue
          if (this._replyTo !== false) this.createPrivateQueue();
        });

        // declare _replyTo queueName
        this._replyTo = options.queue;

        // return data right away
        if (this.config.dlx.enabled !== true) {
          return data;
        }

        // bind temporary queue to headers exchange for DLX messages
        // NOTE: if this fails we might have a problem where expired messages
        // are not delivered & private queue is never ready
        return this
          .bindHeadersExchange(queue, this._replyTo, this.config.dlx.params, 'reply-to')
          .return(data);
      })
      .tap(() => {
        this.log.debug('private-queue-ready', this._replyTo);
        setImmediate(this._boundEmit, 'private-queue-ready');
      })
      .catch((e) => {
        this.log.error('private queue creation failed - restarting', e);
        return this.createPrivateQueue(attempt + 1);
      });
  }

  /**
   * @param {Function} messageHandler
   * @param {Array} listen
   * @param {Object} options
   */
  createConsumedQueue(messageHandler, listen = [], options = {}) {
    if (is.fn(messageHandler) === false || Array.isArray(listen) === false) {
      throw new ArgumentError('messageHandler and listen must be present');
    }

    if (is.object(options) === false) {
      throw new ArgumentError('options');
    }

    const transport = this;
    const { config } = transport;

    const router = initRoutingFn(messageHandler, transport);
    const baseOpts = { router, neck: config.neck, queue: config.queue || '' };
    const queueOptions = merge(baseOpts, config.defaultQueueOpts, this._extraQueueOptions, options);

    if (config.bindPersistantQueueToHeadersExchange === true) {
      listen.forEach((route) => {
        assert.ok(
          /^[^*#]+$/, route,
          'with bindPersistantQueueToHeadersExchange:true routes must not have patterns'
        );
      });
    }

    this.log.debug('creating consumed queue %s with routes', queueOptions.queue, listen);

    // bind to an opened exchange once connected
    function createExchange({ queue }) {
      // eslint-disable-next-line no-use-before-define
      const oldQueue = transport._queues.get(establishConsumer) || {};
      const routes = oldQueue._routes || [];

      if (listen.length === 0 && routes.length === 0) {
        queue._routes = [];
        return null;
      }

      // retrieved some of the routes
      transport.log.debug('retrieved routes', routes, listen);

      const rebindRoutes = uniq([...listen, ...routes]);
      queue._routes = rebindRoutes;

      const work = [
        transport.bindExchange(queue, rebindRoutes, config.exchangeArgs),
      ];

      // bind same queue to headers exchange
      if (config.bindPersistantQueueToHeadersExchange === true) {
        work.push(transport.bindHeadersExchange(queue, rebindRoutes, config.headersExchange));
      }

      return Promise.all(work);
    }

    // pipeline for establishing consumer
    function establishConsumer(attempt = 0) {
      transport.log.debug('[establish consumer]', attempt);

      const oldConsumer = transport._consumers.get(establishConsumer);
      let promise = Promise.bind(transport, transport);

      // if we have old consumer
      if (oldConsumer) {
        transport._consumers.delete(establishConsumer);
        promise = promise.tap(() => closeConsumer.call(transport, oldConsumer));
      }

      return promise
        .call('createQueue', { ...queueOptions })
        .tap(createExchange)
        .catch((e) => {
          throw new ConnectionError('failed to init queue or exchange', e);
        })
        .then(({ consumer, queue }) => {
          // save ref to WeakMap
          transport._consumers.set(establishConsumer, consumer);
          transport._queues.set(establishConsumer, queue);

          // invoke to rebind
          function rebind(err, res) {
            const msg = err && err.replyText;

            // cleanup a bit
            transport.log.warn('re-establishing connection after', msg || err, res || '');

            // if we can't connect - try again in 500 ms in .catch block
            return Promise
              .bind(transport, consumer)
              .then(closeConsumer)
              .delay(transport.recovery.get('consumed', 1))
              .finally(establishConsumer);
          }

          // remove previous listeners if we re-use the channel
          // for any reason
          consumer.removeAllListeners('error');
          consumer.removeAllListeners('cancel');

          // access-refused  403
          //  The client attempted to work with a server entity
          //  to which it has no access due to security settings.
          // not-found  404
          //  The client attempted to work with a server entity that does not exist.
          // resource-locked  405
          //  The client attempted to work with a server entity
          //  to which it has no access because another client is working with it.
          // precondition-failed  406
          //  The client requested a method that was not allowed
          //  because some precondition failed.
          consumer.on('error', (err, res) => {
            const error = err.error || err;

            // https://www.rabbitmq.com/amqp-0-9-1-reference.html -
            switch (error.replyCode) {
              // ignore errors
              case 311:
              case 313:
                transport.log.error('error working with a channel:', err, res);
                return null;

              case 404:
                if (error.replyText && error.replyText.indexOf(queue.queueOptions.queue) !== -1) {
                  rebind(error, res);
                }
                return null;

              default:
                return rebind(error, res);
            }
          });

          consumer.on('cancel', rebind);

          // emit event that we consumer & queue is ready
          transport.log.info('[consumed-queue-reconnected] %s - %s', queue.queueOptions.queue, consumer.consumerTag);
          transport.emit('consumed-queue-reconnected', consumer, queue, establishConsumer);

          return [consumer, queue, establishConsumer];
        })
        .catch(ConnectionError, (e) => {
          transport.log.warn('[consumed-queue-down]', e);
          return Promise
            .resolve(attempt + 1)
            .delay(transport.recovery.get('consumed', attempt + 1))
            .then(establishConsumer);
        });
    }

    // make sure we recreate queue and establish consumer on reconnect
    return establishConsumer().tap(() => {
      transport.log.debug('bound `ready` to establishConsumer for', listen, queueOptions.queue);
      transport.on('ready', establishConsumer);
    });
  }

  /**
   * Stops current running consumers
   */
  stopConsumers() {
    return Promise.map(this.consumers.values(), (bindFn) => {
      return this.stopConsumedQueue(bindFn);
    });
  }

  /**
   * Stops consumed queue from reestablishing connection
   * @returns {Promise<*>}
   */
  stopConsumedQueue(bindFn) {
    this.removeListener('ready', bindFn);
    const consumer = this._consumers.get(bindFn);

    if (!consumer) return Promise.resolve();

    return Promise
      .bind(this, consumer)
      .then(closeConsumer);
  }

  /**
   * Declares exchange and reports 406 error.
   * @param  {Object} params - Exchange params.
   * @returns {Promise<*>}
   */
  declareExchange(params) {
    return this._amqp
      .exchangeAsync(params)
      .call('declareAsync')
      .catch(AMQPTransport.error406, this._on406.bind(this, params));
  }

  /**
   * Binds exchange to queue via route. For Headers exchange
   * automatically populates arguments with routing-key: <route>.
   * @param  {string} exchange - Exchange to bind to.
   * @param  {Queue} queue - Declared queue object.
   * @param  {string} route - Routing key.
   * @param  {boolean} [headerName=false] - if exchange has `headers` type.
   * @returns {Promise<*>}
   */
  bindRoute(exchange, queue, route, headerName = false) {
    const queueName = queue.queueOptions.queue;
    const options = {};
    let routingKey;

    if (headerName === false) {
      routingKey = route;
    } else {
      options.arguments = {
        'x-match': 'any',
        [headerName === true ? 'routing-key' : headerName]: route,
      };
      routingKey = '';
    }

    return queue.bindAsync(exchange, routingKey, options).tap(() => {
      if (Array.isArray(queue._routes)) {
        // reconnect might push an extra route
        if (queue._routes.indexOf(route) === -1) {
          queue._routes.push(route);
        }

        this.log.trace('[queue routes]', queue._routes);
      }

      this.log.debug('queue "%s" bound to exchange "%s" on route "%s"', queueName, exchange, routingKey);
    });
  }

  /**
   * Bind specified queue to exchange
   *
   * @param {object} queue     - queue instance created by .createQueue
   * @param {string} _routes   - messages sent to this route will be delivered to queue
   * @param {object} [opts={}] - exchange parameters:
   *                 https://github.com/dropbox/amqp-coffee#connectionexchangeexchangeargscallback
   */
  bindExchange(queue, _routes, opts = {}) {
    // make sure we have an expanded array of routes
    const routes = toUniqueStringArray(_routes);

    // default params
    const params = merge({
      exchange: this.config.exchange,
      type: this.config.exchangeArgs.type,
      durable: true,
      autoDelete: false,
    }, opts);

    const { exchange } = params;
    assert(exchange, 'exchange name must be specified');
    this.log.debug('bind routes->exchange', routes, exchange);

    return this.declareExchange(params)
      .return(routes)
      .map(route => (
        this.bindRoute(exchange, queue, route)
      ));
  }

  /**
   * Binds multiple routing keys to headers exchange.
   * @param  {Object} queue
   * @param  {mixed} _routes
   * @param  {Object} opts
   * @param  {boolean} [headerName=false] - if exchange has `headers` type
   * @returns {Promise<*>}
   */
  bindHeadersExchange(queue, _routes, opts, headerName = true) {
    // make sure we have an expanded array of routes
    const routes = toUniqueStringArray(_routes);
    // default params
    const params = merge({ durable: true, autoDelete: false }, opts);
    const { exchange } = params;

    // headers exchange
    // do sanity check
    assert.equal(params.type, 'headers');
    assert.ok(exchange, 'exchange must be set');

    this.log.debug('bind routes->exchange/headers', routes, exchange);

    return this.declareExchange(params)
      .return(routes)
      .map((route) => {
        assert.ok(/^[^*#]+$/.test(route));
        return this.bindRoute(exchange, queue, route, headerName);
      });
  }

  /**
   * Unbind specified queue from exchange
   *
   * @param {object} queue   - queue instance created by .createQueue
   * @param {string} _routes - messages sent to this route will be delivered to queue
   */
  unbindExchange(queue, _routes) {
    const { exchange } = this.config;
    const routes = toUniqueStringArray(_routes);

    return Promise.map(routes, route => (
      queue.unbindAsync(exchange, route).tap(() => {
        const queueName = queue.queueOptions.queue;
        if (queue._routes) {
          const idx = queue._routes.indexOf(route);
          if (idx >= 0) {
            queue._routes.splice(idx, 1);
          }

          this.log.debug('queue routes', queue._routes);
        }

        this.log.info('queue "%s" unbound from exchange "%s" on route "%s"', queueName, exchange, route);
      })
    ));
  }

  /**
   * Low-level publishing method
   * @param  {string} exchange
   * @param  {string} queueOrRoute
   * @param  {mixed} _message
   * @param  {Object} options
   * @returns {Promise<*>}
   */
  async sendToServer(exchange, queueOrRoute, _message, options) {
    const publishOptions = this._publishOptions(options);
    const message = options.skipSerialize === true
      ? _message
      : await serialize(_message, publishOptions);

    const request = await this._amqp
      .publishAsync(exchange, queueOrRoute, message, publishOptions);

    // emit original message
    this.emit('publish', queueOrRoute, _message);

    return request;
  }

  /**
   * Send message to specified route
   *
   * @param   {String} route   - destination route
   * @param   {mixed}  message - message to send - will be coerced to string via stringify
   * @param   {Object} options - additional options
   * @param   {Span}   parentSpan
   */
  publish(route, message, options = {}, parentSpan) {
    const span = this.tracer.startSpan(`publish:${route}`, {
      childOf: parentSpan,
    });

    // prepare exchange
    const exchange = is.string(options.exchange)
      ? options.exchange
      : this.config.exchange;

    span.addTags({
      [Tags.SPAN_KIND]: Tags.SPAN_KIND_MESSAGING_PRODUCER,
      [Tags.MESSAGE_BUS_DESTINATION]: `${exchange}:${route}`,
    });

    return wrapPromise(span, this.sendToServer(
      exchange,
      route,
      message,
      options
    ));
  }

  /**
   * Send message to specified queue directly
   *
   * @param {String} queue     - destination queue
   * @param {mixed}  message   - message to send
   * @param {Object} [options] - additional options
   * @param {opentracing.Span} [parentSpan] - Existing span.
   */
  send(queue, message, options = {}, parentSpan) {
    const span = this.tracer.startSpan(`send:${queue}`, {
      childOf: parentSpan,
    });

    // prepare exchange
    const exchange = is.string(options.exchange)
      ? options.exchange
      : '';

    span.addTags({
      [Tags.SPAN_KIND]: Tags.SPAN_KIND_MESSAGING_PRODUCER,
      [Tags.MESSAGE_BUS_DESTINATION]: `${exchange || '<empty>'}:${queue}`,
    });

    return wrapPromise(span, this.sendToServer(
      exchange,
      queue,
      message,
      options
    ));
  }

  /**
   * Sends a message and then awaits for response
   * @param  {String} route
   * @param  {mixed}  message
   * @param  {Object} options
   * @param  {Span}   parentSpan
   * @return {Promise}
   */
  publishAndWait(route, message, options = {}, parentSpan) {
    // opentracing instrumentation
    const span = this.tracer.startSpan(`publishAndWait:${route}`, {
      childOf: parentSpan,
    });

    span.addTags({
      [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
      [Tags.MESSAGE_BUS_DESTINATION]: route,
    });

    return wrapPromise(span, this.createMessageHandler(
      route,
      message,
      options,
      this.publish,
      span
    ));
  }

  /**
   * Send message to specified queue directly and wait for answer
   *
   * @param {string} queue        destination queue
   * @param {any}    message      message to send
   * @param {object} options      additional options
   * @param {Span}   parentSpan
   */
  sendAndWait(queue, message, options = {}, parentSpan) {
    // opentracing instrumentation
    const span = this.tracer.startSpan(`sendAndWait:${queue}`, {
      childOf: parentSpan,
    });

    span.addTags({
      [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
      [Tags.MESSAGE_BUS_DESTINATION]: queue,
    });

    return wrapPromise(span, this.createMessageHandler(
      queue,
      message,
      options,
      this.send
    ));
  }

  /**
   * Specifies default publishing options
   * @param  {Object} options
   * @param  {String} options.exchange - will be overwritten by exchange thats passed
   *  in the publish/send methods
   *  https://github.com/dropbox/amqp-coffee/blob/6d99cf4c9e312c9e5856897ab33458afbdd214e5/src/lib/Publisher.coffee#L90
   * @return {Object}
   */
  _publishOptions(options = {}) {
    // remove unused opts
    const { skipSerialize, gzip: needsGzip, ...opts } = options;

    // force contentEncoding
    if (needsGzip === true) {
      opts.contentEncoding = 'gzip';
    }

    // set default opts
    defaults(opts, this._defaultOpts);

    // append request timeout in headers
    defaults(opts.headers, {
      timeout: opts.timeout || this.config.timeout,
    });

    return opts;
  }

  _replyOptions(options = {}) {
    return {
      simpleResponse: options.simpleResponse === undefined ? this._defaultOpts.simpleResponse : options.simpleResponse,
    };
  }

  /**
   * Reply to sender queue based on headers
   *
   * @param   {Object} properties - incoming message headers
   * @param   {mixed}  message - message to send
   * @param   {Span}   [span] - opentracing span
   * @param   {AMQPMessage} [raw] - raw message
   */
  reply(properties, message, span, raw) {
    if (!properties.replyTo || !properties.correlationId) {
      const error = new ValidationError('replyTo and correlationId not found in properties', 400);

      if (span !== undefined) {
        span.setTag(Tags.ERROR, true);
        span.log({
          event: 'error', 'error.object': error, message: error.message, stack: error.stack,
        });
        span.finish();
      }

      if (raw !== undefined) {
        this.emit('after', raw);
      }

      return Promise.reject(error);
    }

    const options = {
      correlationId: properties.correlationId,
    };

    if (properties[kReplyHeaders]) {
      options.headers = properties[kReplyHeaders];
    }

    let promise = this.send(properties.replyTo, message, options, span);

    if (raw !== undefined) {
      promise = promise
        .finally(() => this.emit('after', raw));
    }

    return span === undefined
      ? promise
      : wrapPromise(span, promise);
  }

  /**
   * Creates local listener for when a private queue is up
   * @returns {Promise<Void|Error>}
   */
  awaitPrivateQueue() {
    /* eslint-disable prefer-const */
    return new Promise((resolve, reject) => {
      let done;
      let error;

      done = function onReady() {
        this.removeAllListeners('error', error);
        error = null;
        resolve();
      };

      error = function onError(err) {
        this.removeListener('private-queue-ready', done);
        done = null;
        reject(err);
      };

      this.once('private-queue-ready', done);
      this.once('error', error);
    });
    /* eslint-enable prefer-const */
  }

  /**
   * Creates response message handler and sets timeout on the response
   * @param  {String}   routing
   * @param  {Object}   options
   * @param  {String}   message
   * @param  {Function} publishMessage
   * @param  {Span}     span - opentracing span
   * @return {Promise}
   */
  createMessageHandler(routing, message, options, publishMessage, span) {
    const replyTo = options.replyTo || this._replyTo;
    const time = process.hrtime();
    const replyOptions = this._replyOptions(options);

    // ensure that reply queue exists before sending request
    if (typeof replyTo !== 'string') {
      const promise = replyTo === false
        ? this.awaitPrivateQueue()
        : this.createPrivateQueue();

      return promise
        .return(this)
        .call('createMessageHandler', routing, message, options, publishMessage, span);
    }

    // work with cache if options.cache is set and is number
    // otherwise cachedResponse is always null
    const cachedResponse = this.cache.get(message, options.cache);
    if (cachedResponse !== null && typeof cachedResponse === 'object') {
      return Promise.resolve(adaptResponse(cachedResponse.value, replyOptions));
    }

    const { replyStorage } = this;
    // generate response id
    const correlationId = options.correlationId || uuid.v4();
    // timeout before RPC times out
    const timeout = options.timeout || this.config.timeout;

    // slightly longer timeout, if message was not consumed in time, it will return with expiration
    const publishPromise = new Promise((resolve, reject) => {
      // push into RPC request storage
      replyStorage.push(correlationId, {
        timeout,
        time,
        routing,
        resolve,
        reject,
        replyOptions,
        cache: cachedResponse,
        timer: null,
      });
    });

    // debugging
    this.log.trace('message pushed into reply queue in %s', latency(time));

    // add custom header for routing over amq.headers exchange
    set(options, 'headers.reply-to', replyTo);

    // add opentracing instrumentation
    if (span) {
      this.tracer.inject(span.context(), FORMAT_TEXT_MAP, options.headers);
    }

    // this is to ensure that queue is not overflown and work will not
    // be completed later on
    publishMessage
      .call(this, routing, message, {
        ...options,
        replyTo,
        correlationId,
        expiration: Math.ceil(timeout * 0.9).toString(),
      }, span)
      .tap(() => {
        this.log.trace('message published in %s', latency(time));
      })
      .catch((err) => {
        this.log.error('error sending message', err);
        replyStorage.reject(correlationId, err);
      });

    return publishPromise;
  }

  /**
   *
   * @param  {Object} message
   *  - @param {Object} data: a getter that returns the data in its parsed form, eg a
   *                           parsed json object, a string, or the raw buffer
   *  - @param {Object} raw: the raw buffer that was returned
   *  - @param {Object} properties: headers specified for the message
   *  - @param {Number} size: message body size
   *  - @param {Function} ack(): function : only used when prefetchCount is specified
   *  - @param {Function} reject(): function: only used when prefetchCount is specified
   *  - @param {Function} retry(): function: only used when prefetchCount is specified
   */
  _onConsume = (_router) => {
    assert(is.fn(_router), '`router` must be a function');

    // use bind as it is now fast
    const amqpTransport = this;
    const parseInput = amqpTransport._parseInput.bind(amqpTransport);
    const router = _router.bind(amqpTransport);

    return async function consumeMessage(incoming) {
      // emit pre processing hook
      amqpTransport.emit('pre', incoming);

      // extract message data
      const { properties } = incoming;
      const { contentType, contentEncoding } = properties;

      // parsed input data
      const message = await parseInput(incoming.raw, contentType, contentEncoding);
      // useful message properties
      const props = extend({}, properties, pick(incoming, AMQPTransport.extendMessageProperties));

      // pass to the consumer message router
      // message - properties - incoming
      //  incoming.raw<{ ack: ?Function, reject: ?Function, retry: ?Function }>
      //  and everything else from amqp-coffee
      setImmediate(router, message, props, incoming);
    };
  };

  /**
   * Distributes messages from a private queue
   * @param  {mixed}  message
   * @param  {Object} properties
   */
  _privateMessageRouter(message, properties/* , raw */) { // if private queue has nack set - we must ack msg
    const { correlationId, replyTo, headers } = properties;
    const { 'x-death': xDeath } = headers;

    // retrieve promised message
    const future = this.replyStorage.pop(correlationId);

    // case 1 - for some reason there is no saved reference, example - crashed process
    if (future === undefined) {
      this.log.error('no recipient for the message %j and id %s', message.error || message.data || message, correlationId);

      let error;
      if (xDeath) {
        error = new AmqpDLXError(xDeath, message);
        this.log.warn('message was not processed', error);
      }

      // otherwise we just run messages in circles
      if (replyTo && replyTo !== this._replyTo) {
        // if error is undefined - generate this
        if (error === undefined) {
          error = new NotPermittedError(`no recipients found for correlationId "${correlationId}"`);
        }

        // reply with the error
        return this.reply(properties, { error });
      }

      // we are done
      return null;
    }

    this.log.trace('response returned in %s', latency(future.time));

    // if message was dead-lettered - reject with an error
    if (xDeath) {
      return future.reject(new AmqpDLXError(xDeath, message));
    }

    if (message.error) {
      const error = wrapError(message.error);

      Object.defineProperty(error, kReplyHeaders, {
        value: headers,
        enumerable: false,
      });

      return future.reject(error);
    }

    const response = buildResponse(message, properties);
    this.cache.set(future.cache, response);

    return future.resolve(adaptResponse(response, future.replyOptions));
  }

  /**
   * Parses AMQP message
   * @param  {Buffer} _data
   * @param  {String} [contentType='application/json']
   * @param  {String} [contentEncoding='plain']
   * @return {Object}
   */
  async _parseInput(_data, contentType = 'application/json', contentEncoding = 'plain') {
    let data;

    switch (contentEncoding) {
      case 'gzip':
        data = await gunzip(_data).catchReturn({ err: PARSE_ERR });
        break;

      case 'plain':
        data = _data;
        break;

      default:
        return { err: PARSE_ERR };
    }

    switch (contentType) {
      // default encoding when we were pre-stringifying and sending str
      // and our updated encoding when we send buffer now
      case 'string/utf8':
      case 'application/json':
        return safeJSONParse(data, this.log);

      default:
        return data;
    }
  }

  /**
   * Registers consumers for further access
   * @param {consumer} consumer
   * @param {queue} queue
   * @param {establishConsumer fn} bindFn
   */
  _registerConsumer(consumer, queue, bindFn) {
    this.consumers.set(consumer, bindFn);
  }

  /**
   * Removes binding when closeConsumer helper called
   * @param {*} consumer
   */
  _unregisterConsumer(consumer) {
    this.consumers.delete(consumer);
  }

  /**
   * Handle 406 Error.
   * @param  {Object} params - exchange params
   * @param  {Error}  err    - 406 Conflict Error.
   */
  _on406 = (params, err) => {
    this.log.warn({ params }, '[406] error declaring exchange/queue:', err.replyText);
  };

  /**
   * 'ready' event from amqp-coffee lib, perform queue recreation here
   */
  _onConnect = () => {
    const { serverProperties } = this._amqp;
    const { cluster_name: clusterName, version } = serverProperties;

    // emit connect event through log
    this.log.info('connected to %s v%s', clusterName, version);

    // https://github.com/dropbox/amqp-coffee#reconnect-flow
    // recreate unnamed private queue
    if ((this._replyTo || this.config.private) && this._replyTo !== false) {
      this.createPrivateQueue();
    }

    this.on('consumed-queue-reconnected', this._boundRegisterConsumer);
    this.on('consumer-close', this._unregisterConsumer);
    // re-emit ready
    this.emit('ready');
  };

  /**
   * Pass in close event
   */
  _onClose = (err) => {
    // emit connect event through log
    this.log.error('connection is closed. Had an error:', err || '<n/a>');
    this.removeListener('consumed-queue-reconnected', this._boundRegisterConsumer);
    this.removeListener('consumer-close', this._unregisterConsumer);
    // re-emit close event
    this.emit('close', err);
  };
}

// expose static connectors
helpers(AMQPTransport);

// assign statics
module.exports = AMQPTransport;
