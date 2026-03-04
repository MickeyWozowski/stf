var crypto = require('crypto')
var fs = require('fs')
var url = require('url')
var util = require('util')
var cp = require('child_process')

var Promise = require('bluebird')
var request = require('@cypress/request')

var download = require('../../util/download')
var lifecycle = require('../../util/lifecycle')
var logger = require('../../util/logger')
var srv = require('../../util/srv')
var timeutil = require('../../util/timeutil')
var wire = require('../../wire')
var wireutil = require('../../wire/util')
var zmqutil = require('../../util/zmqutil')

function toNumber(value, defaultValue) {
  var parsed = parseInt(value, 10)
  return isNaN(parsed) ? defaultValue : parsed
}

function normalizeMode(value) {
  var normalized = String(value || 'disabled').trim().toLowerCase()
  return ['disabled', 'host-bridge'].indexOf(normalized) !== -1 ?
    normalized :
    'disabled'
}

function resolveTemplate(template, values) {
  return String(template).replace(/\$\{([^}]+)\}/g, function(all, key) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return values[key]
    }
    return ''
  })
}

function makeDeviceChannel(serial) {
  var hash = crypto.createHash('sha1')
  hash.update(serial)
  return hash.digest('base64')
}

function parseCoordinatorEvent(data) {
  var parsed
  try {
    parsed = JSON.parse(data.toString())
  }
  catch (err) {
    return null
  }

  var eventType = String(parsed.type || parsed.Type || '').trim().toLowerCase()
  var serial = String(parsed.uuid || parsed.UUID || '').trim()
  if (!eventType || !serial) {
    return null
  }

  return {
    type: eventType
  , serial: serial
  , name: parsed.name || parsed.Name || null
  , wdaPort: toNumber(parsed.wdaPort || parsed.WDAPort, 0)
  , videoPort: toNumber(parsed.vidPort || parsed.VidPort, 0)
  , providerIp: parsed.providerIp || parsed.ProviderIp || null
  , iosVersion: parsed.iosVersion || parsed.IosVersion || null
  , productType: parsed.productType || parsed.ProductType || null
  , productVersion: parsed.productVersion || parsed.ProductVersion || null
  , width: toNumber(parsed.width || parsed.Width, 0)
  , height: toNumber(parsed.height || parsed.Height, 0)
  , clickWidth: toNumber(parsed.clickWidth || parsed.ClickWidth, 0)
  , clickHeight: toNumber(parsed.clickHeight || parsed.ClickHeight, 0)
  , transport: parsed.transport || parsed.Transport || 'usbmux'
  }
}

function execFileWithTimeout(binary, args, timeout, extraOptions) {
  var execOptions = Object.assign({
    timeout: timeout
  , maxBuffer: 1024 * 1024 * 10
  }, extraOptions || {})

  return new Promise(function(resolve, reject) {
    cp.execFile(binary, args, execOptions, function(err, stdout, stderr) {
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
        return
      }
      resolve({
        stdout: stdout
      , stderr: stderr
      })
    })
  })
}

module.exports = function(options) {
  var opts = Object.assign({
      mode: 'disabled'
    , name: null
    , provider: null
    , publicIp: 'localhost'
    , pollInterval: 10000
    , storageUrl: null
    , iosDeployPath: '/usr/local/bin/ios-deploy'
    , xcodeDeveloperDir: process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer'
    , actionTimeout: 300000
    , screenWsUrlPattern: 'wss://${publicIp}/frames/${providerIp}/${videoPort}/x'
    , wdaHost: '127.0.0.1'
    , coordinatorEventTopic: 'devEvent'
    , coordinatorEventEndpoints: ['tcp://127.0.0.1:7294']
    , endpoints: {
        push: []
      , sub: []
      }
    }
  , options || {})

  opts.mode = normalizeMode(opts.mode)
  opts.actionTimeout = Math.max(1000, toNumber(opts.actionTimeout, 300000))

  var log = logger.createLogger('ios-provider')
  var ticker = null
  var providerChannel = wireutil.makePrivateChannel()
  var devicesBySerial = Object.create(null)
  var serialByDeviceChannel = Object.create(null)

  if (opts.name) {
    logger.setGlobalIdentifier(opts.name)
  }

  if (opts.mode === 'disabled') {
    log.info('iOS provider is disabled')
    return
  }

  if (opts.mode !== 'host-bridge') {
    log.fatal('Unsupported iOS provider mode "%s"', opts.mode)
    lifecycle.fatal()
    return
  }

  if (!opts.endpoints.push.length || !opts.endpoints.sub.length) {
    log.warn('iOS provider host-bridge mode started without complete STF endpoints')
  }

  var push = zmqutil.socket('push')
  Promise.map(opts.endpoints.push, function(endpoint) {
    return srv.resolve(endpoint).then(function(records) {
      return srv.attempt(records, function(record) {
        log.info('Sending STF output to "%s"', record.url)
        push.connect(record.url)
        return Promise.resolve(true)
      })
    })
  })
  .catch(function(err) {
    log.fatal('Unable to connect to STF push endpoint', err)
    lifecycle.fatal()
  })

  var sub = zmqutil.socket('sub')
  Promise.map(opts.endpoints.sub, function(endpoint) {
    return srv.resolve(endpoint).then(function(records) {
      return srv.attempt(records, function(record) {
        log.info('Receiving STF input from "%s"', record.url)
        sub.connect(record.url)
        return Promise.resolve(true)
      })
    })
  })
  .catch(function(err) {
    log.fatal('Unable to connect to STF sub endpoint', err)
    lifecycle.fatal()
  })

  var coordinatorSub = zmqutil.socket('sub')
  Promise.map(opts.coordinatorEventEndpoints, function(endpoint) {
    return srv.resolve(endpoint).then(function(records) {
      return srv.attempt(records, function(record) {
        log.info('Receiving coordinator events from "%s"', record.url)
        coordinatorSub.connect(record.url)
        return Promise.resolve(true)
      })
    })
  })
  .catch(function(err) {
    log.fatal('Unable to connect to coordinator event endpoint', err)
    lifecycle.fatal()
  })

  ;[wireutil.global, providerChannel].forEach(function(channel) {
    log.info('Subscribing to STF channel "%s"', channel)
    sub.subscribe(channel)
  })

  log.info('Subscribing to coordinator topic "%s"', opts.coordinatorEventTopic)
  coordinatorSub.subscribe(opts.coordinatorEventTopic)

  function ensureDevice(serial) {
    if (!devicesBySerial[serial]) {
      var deviceChannel = makeDeviceChannel(serial)
      var device = devicesBySerial[serial] = {
        serial: serial
      , channel: deviceChannel
      , introduced: false
      , registered: false
      , ready: false
      , wdaSessionId: null
      , clickDimensionsReady: false
      , name: null
      , wdaPort: 0
      , videoPort: 0
      , providerIp: null
      , iosVersion: null
      , productType: null
      , productVersion: null
      , width: 1170
      , height: 2532
      , clickWidth: 0
      , clickHeight: 0
      , transport: 'usbmux'
      , simulator: false
      }

      serialByDeviceChannel[deviceChannel] = serial
      sub.subscribe(deviceChannel)
      log.info('Subscribed device channel "%s" for "%s"', deviceChannel, serial)
      return device
    }
    return devicesBySerial[serial]
  }

  function mergeEventDeviceData(device, event) {
    if (event.name) {
      device.name = event.name
    }
    if (event.wdaPort) {
      device.wdaPort = event.wdaPort
    }
    if (event.videoPort) {
      device.videoPort = event.videoPort
    }
    if (event.providerIp) {
      device.providerIp = event.providerIp
    }
    if (event.iosVersion) {
      device.iosVersion = event.iosVersion
    }
    if (event.productType) {
      device.productType = event.productType
    }
    if (event.productVersion) {
      device.productVersion = event.productVersion
    }
    if (event.width > 0) {
      device.width = event.width
    }
    if (event.height > 0) {
      device.height = event.height
    }
    if (event.clickWidth > 0) {
      device.clickWidth = event.clickWidth
    }
    if (event.clickHeight > 0) {
      device.clickHeight = event.clickHeight
    }
    if (device.clickWidth > 0 && device.clickHeight > 0) {
      device.clickDimensionsReady = true
    }
    if (event.transport) {
      device.transport = event.transport
    }
  }

  function toScreenUrl(device) {
    var providerIp = device.providerIp || opts.publicIp || '127.0.0.1'
    return resolveTemplate(opts.screenWsUrlPattern, {
      publicIp: opts.publicIp
    , providerIp: providerIp
    , videoPort: String(device.videoPort || 0)
    , serial: device.serial
    })
  }

  function sendDeviceIntroduction(device) {
    if (device.introduced) {
      return
    }

    push.send([
      wireutil.global
    , wireutil.envelope(new wire.DeviceIntroductionMessage(
        device.serial
      , wire.DeviceStatus.ONLINE
      , new wire.ProviderMessage(
          providerChannel
        , opts.provider || opts.name || 'ios-provider'
        )
      , timeutil.now('nano')
      ))
    ])

    device.introduced = true
    log.info('Introduced iOS device "%s"', device.serial)
  }

  function sendDevicePresent(device) {
    push.send([
      wireutil.global
    , wireutil.envelope(new wire.DevicePresentMessage(
        device.serial
      ))
    ])
  }

  function sendDeviceAbsent(device) {
    push.send([
      wireutil.global
    , wireutil.envelope(new wire.DeviceAbsentMessage(
        device.serial
      ))
    ])
  }

  function sendDeviceHeartbeat(device) {
    push.send([
      wireutil.global
    , wireutil.envelope(new wire.DeviceHeartbeatMessage(
        device.serial
      ))
    ])
  }

  function sendDeviceReady(device) {
    push.send([
      wireutil.global
    , wireutil.envelope(new wire.DeviceReadyMessage(
        device.serial
      , device.channel
      ))
    ])
  }

  function sendDeviceIdentity(device) {
    var display = new wire.DeviceDisplayMessage({
      id: 0
    , width: device.width
    , height: device.height
    , rotation: 0
    , xdpi: 460
    , ydpi: 460
    , fps: 30
    , density: 3
    , secure: true
    , url: toScreenUrl(device)
    })

    var ios = new wire.DeviceIosField({
      udid: device.serial
    , name: device.name || null
    , productType: device.productType || null
    , productVersion: device.productVersion || device.iosVersion || null
    , simulator: !!device.simulator
    , transport: device.transport || 'usbmux'
    })

    push.send([
      wireutil.global
    , wireutil.envelope(new wire.DeviceIdentityMessage(
        device.serial
      , 'iOS'
      , 'Apple'
      , null
      , device.name || 'iPhone'
      , device.iosVersion || device.productVersion || '0'
      , 'arm64'
      , '0'
      , display
      , new wire.DevicePhoneMessage({})
      , device.productType || null
      , null
      , null
      , device.name || null
      , 'ios'
      , ios
      ))
    ])
  }

  function requestJson(method, requestUrl, body) {
    return new Promise(function(resolve, reject) {
      request({
        method: method
      , url: requestUrl
      , json: true
      , body: body
      , strictSSL: false
      }, function(err, response, responseBody) {
        if (err) {
          reject(err)
          return
        }
        var statusCode = response && response.statusCode || 0
        if (statusCode < 200 || statusCode >= 300) {
          var details = ''
          if (responseBody && typeof responseBody === 'object') {
            details = responseBody.value && responseBody.value.message ||
              responseBody.message ||
              ''
          }
          else if (typeof responseBody === 'string') {
            details = responseBody
          }

          details = String(details || '').trim()
          if (details.length > 180) {
            details = details.slice(0, 180) + '...'
          }

          reject(new Error(util.format(
            details ?
              'HTTP %d from %s %s: %s' :
              'HTTP %d from %s %s'
          , statusCode
          , method
          , requestUrl
          , details
          )))
          return
        }
        resolve(responseBody)
      })
    })
  }

  function requestWda(device, method, path, body) {
    var requestUrl = util.format(
      'http://%s:%d%s'
    , opts.wdaHost
    , device.wdaPort
    , path
    )
    return requestJson(method, requestUrl, body)
  }

  function updateTapDimensionsFromWda(device, sessionId) {
    return requestWda(device, 'GET', util.format(
      '/session/%s/window/size'
    , sessionId
    ))
      .then(function(windowSizeBody) {
        var windowValue = windowSizeBody && (
          windowSizeBody.value || windowSizeBody
        )
        if (!windowValue) {
          throw new Error('WDA window size response missing value payload')
        }

        var width = toNumber(windowValue.width, 0)
        var height = toNumber(windowValue.height, 0)
        if (!width || !height) {
          throw new Error('WDA window size response missing width/height')
        }

        var changed = device.clickWidth !== width || device.clickHeight !== height
        device.clickWidth = width
        device.clickHeight = height
        device.clickDimensionsReady = true

        if (changed) {
          log.info(
            'Updated iOS tap dimensions for "%s" to %dx%d via WDA'
          , device.serial
          , width
          , height
          )
        }
      })
      .catch(function(err) {
        log.warn(
          'Unable to refresh iOS tap dimensions for "%s": %s'
        , device.serial
        , err.message
        )
      })
  }

  function ensureWdaSession(device) {
    if (!device.wdaPort) {
      return Promise.reject(new Error('WDA port not available'))
    }
    if (device.wdaSessionId) {
      if (device.clickDimensionsReady) {
        return Promise.resolve(device.wdaSessionId)
      }
      return updateTapDimensionsFromWda(device, device.wdaSessionId)
        .then(function() {
          return device.wdaSessionId
        })
    }

    return requestWda(device, 'GET', '/status')
      .then(function(statusBody) {
        var sessionId = statusBody && (
          statusBody.sessionId ||
          statusBody.value && statusBody.value.sessionId
        )

        if (sessionId) {
          device.wdaSessionId = sessionId
          device.clickDimensionsReady = false
          return updateTapDimensionsFromWda(device, sessionId)
            .then(function() {
              return sessionId
            })
        }

        return requestWda(device, 'POST', '/session', {
          capabilities: {
            alwaysMatch: {}
          , firstMatch: [
              {
                shouldUseSingletonTestManager: true
              , shouldUseTestManagerForVisibilityDetection: false
              , shouldWaitForQuiescence: true
              }
            ]
          }
        })
          .then(function(createBody) {
            var createdSessionId = createBody && (
              createBody.sessionId ||
              createBody.value && createBody.value.sessionId
            )
            if (!createdSessionId) {
              throw new Error('Unable to establish WDA session')
            }
            device.wdaSessionId = createdSessionId
            device.clickDimensionsReady = false
            return updateTapDimensionsFromWda(device, createdSessionId)
              .then(function() {
                return createdSessionId
              })
          })
      })
  }

  function normalizedToPixel(value, max) {
    var normalized = Math.max(0, Math.min(1, Number(value || 0)))
    return Math.round(normalized * Math.max(1, max))
  }

  function buildTapActionPayload(x, y) {
    return {
      actions: [
        {
          type: 'pointer'
        , id: 'finger1'
        , parameters: {
            pointerType: 'touch'
          }
        , actions: [
            {
              type: 'pointerMove'
            , duration: 0
            , x: Math.floor(x)
            , y: Math.floor(y)
            }
          , {
              type: 'pointerDown'
            , button: 0
            }
          , {
              type: 'pause'
            , duration: 60
            }
          , {
              type: 'pointerUp'
            , button: 0
            }
          ]
        }
      ]
    }
  }

  function isRouteMissingError(err) {
    if (!err || !err.message) {
      return false
    }
    return /HTTP (404|405|501)\b/i.test(err.message) ||
      /unknown command|not implemented|unhandled endpoint/i.test(err.message)
  }

  function isInvalidSessionError(err) {
    if (!err || !err.message) {
      return false
    }
    return /invalid session id|session .* does not exist|no such driver/i.test(
      String(err.message).toLowerCase()
    )
  }

  function requestWdaWithFallback(device, requests) {
    function next(index, previousErr) {
      if (index >= requests.length) {
        throw previousErr || new Error('No WDA request candidates were provided')
      }

      var req = requests[index]
      return requestWda(device, req.method || 'POST', req.path, req.body || {})
        .catch(function(err) {
          if (!isRouteMissingError(err)) {
            throw err
          }
          return next(index + 1, err)
        })
    }

    return next(0, null)
  }

  function pressHome(device, sessionId) {
    var requests = []

    if (sessionId) {
      requests.push({
        method: 'POST'
      , path: util.format('/session/%s/wda/homescreen', sessionId)
      , body: {}
      })
      requests.push({
        method: 'POST'
      , path: util.format('/session/%s/wda/pressButton', sessionId)
      , body: {
          name: 'home'
        }
      })
    }

    requests.push({
      method: 'POST'
    , path: '/wda/homescreen'
    , body: {}
    })
    requests.push({
      method: 'POST'
    , path: '/wda/pressButton'
    , body: {
        name: 'home'
      }
    })

    return requestWdaWithFallback(device, requests)
  }

  function handleTouchDown(device, message) {
    return ensureWdaSession(device)
      .then(function(sessionId) {
        var x = normalizedToPixel(message.x, device.clickWidth || device.width)
        var y = normalizedToPixel(message.y, device.clickHeight || device.height)
        log.debug(
          'Dispatching iOS tap for "%s" session=%s x=%d y=%d rawX=%s rawY=%s tapW=%d tapH=%d'
        , device.serial
        , sessionId
        , x
        , y
        , message.x
        , message.y
        , device.clickWidth || device.width
        , device.clickHeight || device.height
        )
        return requestWda(device, 'POST', util.format(
          '/session/%s/actions'
        , sessionId
        ), buildTapActionPayload(x, y))
          .catch(function(err) {
            if (!isRouteMissingError(err)) {
              throw err
            }

            // Older WDA builds may only support the legacy /wda/tap endpoint.
            return requestWda(device, 'POST', util.format(
              '/session/%s/wda/tap/0'
            , sessionId
            ), {
              x: x
            , y: y
            })
        })
      })
      .catch(function(err) {
        log.warn(
          'Failed to execute iOS tap on "%s": %s'
        , device.serial
        , err.message
        )
      })
  }

  function handleKeyPress(device, message) {
    if (String(message.key || '').toLowerCase() !== 'home') {
      return
    }

    function executeHomePress(retryOnInvalidSession) {
      return ensureWdaSession(device)
        .then(function(sessionId) {
          return pressHome(device, sessionId)
        })
        .catch(function(err) {
          if (!isRouteMissingError(err)) {
            throw err
          }
          // Some WDA builds expose homescreen press only via non-session routes.
          return pressHome(device, null)
        })
        .catch(function(err) {
          if (!retryOnInvalidSession || !isInvalidSessionError(err)) {
            throw err
          }

          // WDA restart invalidates cached session IDs; retry once with a fresh session.
          device.wdaSessionId = null
          device.clickDimensionsReady = false
          return executeHomePress(false)
        })
    }

    executeHomePress(true)
      .catch(function(err) {
        log.warn(
          'Failed to execute iOS home press on "%s" (WDA %s:%d): %s'
        , device.serial
        , opts.wdaHost
        , device.wdaPort
        , err.message
        )
      })
  }

  function handleType(device, message) {
    if (!message.text) {
      return
    }

    ensureWdaSession(device)
      .then(function(sessionId) {
        return requestWda(device, 'POST', util.format(
          '/session/%s/wda/keys'
        , sessionId
        ), {
          value: String(message.text).split('')
        })
      })
      .catch(function(err) {
        log.warn(
          'Failed to execute iOS typing on "%s": %s'
        , device.serial
        , err.message
        )
      })
  }

  function extractScreenshotBase64(responseBody) {
    var value = null
    if (responseBody && typeof responseBody === 'object') {
      value = responseBody.value || responseBody.screenshot || null
    }
    else if (typeof responseBody === 'string') {
      value = responseBody
    }

    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('WDA screenshot response did not contain image data')
    }

    var normalized = value.trim()
    if (normalized.indexOf('base64,') !== -1) {
      normalized = normalized.split('base64,').pop()
    }
    return normalized
  }

  function requestWdaScreenshot(device) {
    return ensureWdaSession(device)
      .then(function(sessionId) {
        return requestWda(device, 'GET', util.format(
          '/session/%s/screenshot'
        , sessionId
        ))
      })
      .catch(function() {
        return requestWda(device, 'GET', '/screenshot')
      })
      .then(function(responseBody) {
        var base64Payload = extractScreenshotBase64(responseBody)
        var screenshot = Buffer.from(base64Payload, 'base64')
        if (!screenshot.length) {
          throw new Error('Captured screenshot is empty')
        }
        return screenshot
      })
  }

  function storeBlob(type, payload, meta) {
    if (!opts.storageUrl) {
      return Promise.reject(new Error('Missing --storage-url for iOS screenshot actions'))
    }

    var uploadUrl = url.resolve(opts.storageUrl, util.format('s/upload/%s', type))
    return new Promise(function(resolve, reject) {
      var req = request.post({
        url: uploadUrl
      }, function(err, res, body) {
        if (err) {
          reject(err)
          return
        }

        if (!res || res.statusCode !== 201) {
          reject(new Error(util.format(
            'Upload to "%s" failed: HTTP %d'
          , uploadUrl
          , res && res.statusCode || 0
          )))
          return
        }

        var parsed
        try {
          var normalizedBody = Buffer.isBuffer(body) ? body.toString('utf8') : body
          parsed = typeof normalizedBody === 'string' ? JSON.parse(normalizedBody) : normalizedBody
        }
        catch (parseErr) {
          reject(parseErr)
          return
        }

        if (!parsed || !parsed.resources || !parsed.resources.file) {
          reject(new Error('Storage upload response missing resources.file'))
          return
        }

        resolve(parsed.resources.file)
      })

      req.form()
        .append('file', payload, meta)
    })
  }

  function handleScreenCapture(device, responseChannel) {
    var reply = wireutil.reply(device.serial)
    var filename = util.format('%s-%d.png', device.serial, Date.now())

    requestWdaScreenshot(device)
      .then(function(screenshotBuffer) {
        return storeBlob('image', screenshotBuffer, {
          filename: filename
        , contentType: 'image/png'
        , knownLength: screenshotBuffer.length
        })
      })
      .then(function(file) {
        push.send([
          responseChannel
        , reply.okay('success', file)
        ])
      })
      .catch(function(err) {
        log.warn(
          'Failed iOS screenshot for "%s": %s'
        , device.serial
        , err.message
        )
        push.send([
          responseChannel
        , reply.fail('fail')
        ])
      })
  }

  function resolveStorageHref(href) {
    if (!opts.storageUrl) {
      throw new Error('Missing --storage-url for iOS install actions')
    }
    return url.resolve(opts.storageUrl, href)
  }

  function sendTxProgress(reply, responseChannel, data, progress) {
    push.send([
      responseChannel
    , reply.progress(data, progress)
    ])
  }

  function sendTxDone(reply, responseChannel, okay, code) {
    push.send([
      responseChannel
    , okay ? reply.okay(code) : reply.fail(code)
    ])
  }

  function parseBundleIdFromLaunch(message) {
    var component = String(message.component || '').trim()
    if (!component) {
      return null
    }
    return component.split('/')[0]
  }

  function shouldFallbackToDeviceCtl(err) {
    var details = [
      err && err.message
    , err && err.stderr
    , err && err.stdout
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()

    if (!details) {
      return false
    }

    return details.indexOf('developerdiskimage.dmg') !== -1 ||
      details.indexOf('requires xcode') !== -1 ||
      details.indexOf('one of -[b|c|o|l|w|d|n|r|x|e|b|c|s|9] is required to proceed') !== -1
  }

  function classifyIosActionError(err, fallbackCode) {
    var details = [
      err && err.message
    , err && err.stderr
    , err && err.stdout
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()

    if (details.indexOf('developer mode is disabled') !== -1) {
      return 'DEVELOPER_MODE_DISABLED'
    }

    if (details.indexOf('developerdiskimage.dmg') !== -1) {
      return 'XCODE_DEVICE_SUPPORT_MISSING'
    }

    return fallbackCode
  }

  function runIosDeploy(args) {
    return execFileWithTimeout(opts.iosDeployPath, args, opts.actionTimeout)
      .then(function(result) {
        log.info('ios-deploy finished (%s)', args.join(' '))
        if (result.stdout) {
          log.info(result.stdout.trim())
        }
        if (result.stderr) {
          log.warn(result.stderr.trim())
        }
      })
      .catch(function(err) {
        var stderr = err.stderr ? (' stderr: ' + err.stderr.trim()) : ''
        log.error(
          'ios-deploy failed (%s): %s%s'
        , args.join(' ')
        , err.message
        , stderr
        )
        throw err
      })
  }

  function runDeviceCtl(args) {
    var env = Object.assign({}, process.env)
    if (opts.xcodeDeveloperDir) {
      env.DEVELOPER_DIR = opts.xcodeDeveloperDir
    }

    return execFileWithTimeout('/usr/bin/xcrun', ['devicectl'].concat(args), opts.actionTimeout, {
      env: env
    })
      .then(function(result) {
        log.info('devicectl finished (%s)', args.join(' '))
        if (result.stdout) {
          log.info(result.stdout.trim())
        }
        if (result.stderr) {
          log.warn(result.stderr.trim())
        }
      })
      .catch(function(err) {
        var stderr = err.stderr ? (' stderr: ' + err.stderr.trim()) : ''
        log.error(
          'devicectl failed (%s): %s%s'
        , args.join(' ')
        , err.message
        , stderr
        )
        throw err
      })
  }

  function launchBundle(device, bundleId) {
    return runIosDeploy([
      '--id', device.serial
    , '--nolldb'
    , '--justlaunch'
    , '--bundle_id', bundleId
    ])
      .catch(function(err) {
        if (!shouldFallbackToDeviceCtl(err)) {
          throw err
        }

        log.warn(
          'Falling back to devicectl launch for "%s" (bundle "%s")'
        , device.serial
        , bundleId
        )

        return runDeviceCtl([
          'device', 'process', 'launch'
        , '--device', device.serial
        , bundleId
        , '--terminate-existing'
        ])
      })
  }

  function handleInstall(device, responseChannel, message) {
    var reply = wireutil.reply(device.serial)
    var filePath = null
    var installUrl

    try {
      installUrl = resolveStorageHref(message.href)
    }
    catch (err) {
      sendTxDone(reply, responseChannel, false, 'INSTALL_ERROR_UNKNOWN')
      return
    }

    sendTxProgress(reply, responseChannel, 'downloading_app', 0)

    download(installUrl, {
      suffix: '.ipa'
    })
      .progressed(function(state) {
        if (state.lengthComputable && state.total > 0) {
          var downloadProgress = Math.floor((state.loaded / state.total) * 60)
          sendTxProgress(
            reply
          , responseChannel
          , 'downloading_app'
          , Math.max(0, Math.min(60, downloadProgress))
          )
        }
      })
      .then(function(result) {
        filePath = result.path
        sendTxProgress(reply, responseChannel, 'installing_app', 70)
        var args = [
          '--id', device.serial
        , '--bundle', filePath
        ]
        if (message.launch === true) {
          args.push('--nolldb')
          args.push('--justlaunch')
        }
        return runIosDeploy(args)
      })
      .then(function() {
        sendTxDone(reply, responseChannel, true, 'INSTALL_SUCCEEDED')
      })
      .catch(function(err) {
        if (err.killed && err.signal === 'SIGTERM') {
          sendTxDone(reply, responseChannel, false, 'INSTALL_ERROR_TIMEOUT')
          return
        }
        sendTxDone(reply, responseChannel, false, 'INSTALL_ERROR_UNKNOWN')
      })
      .finally(function() {
        if (filePath) {
          fs.unlink(filePath, function() {})
        }
      })
  }

  function handleUninstall(device, responseChannel, message) {
    var reply = wireutil.reply(device.serial)
    var bundleId = String(message.packageName || '').trim()
    if (!bundleId) {
      sendTxDone(reply, responseChannel, false, 'fail')
      return
    }

    runIosDeploy([
      '--id', device.serial
    , '--uninstall_only'
    , '--bundle_id', bundleId
    ])
      .catch(function(err) {
        if (!shouldFallbackToDeviceCtl(err)) {
          throw err
        }

        log.warn(
          'Falling back to devicectl uninstall for "%s" (bundle "%s")'
        , device.serial
        , bundleId
        )

        return runDeviceCtl([
          'device', 'uninstall', 'app'
        , '--device', device.serial
        , bundleId
        ])
      })
      .then(function() {
        sendTxDone(reply, responseChannel, true, 'success')
      })
      .catch(function(err) {
        sendTxDone(reply, responseChannel, false, classifyIosActionError(err, 'fail'))
      })
  }

  function handleLaunch(device, responseChannel, message) {
    var reply = wireutil.reply(device.serial)
    var bundleId = parseBundleIdFromLaunch(message)
    if (!bundleId) {
      sendTxDone(reply, responseChannel, false, 'fail')
      return
    }

    launchBundle(device, bundleId)
      .then(function() {
        sendTxDone(reply, responseChannel, true, 'success')
      })
      .catch(function(err) {
        sendTxDone(reply, responseChannel, false, classifyIosActionError(err, 'fail'))
      })
  }

  function onCoordinatorEvent(event) {
    var device = ensureDevice(event.serial)
    mergeEventDeviceData(device, event)

    switch (event.type) {
      case 'connect':
        sendDeviceIntroduction(device)
        break
      case 'present':
        sendDeviceIntroduction(device)
        sendDevicePresent(device)
        break
      case 'heartbeat':
        sendDeviceIntroduction(device)
        sendDeviceHeartbeat(device)
        break
      case 'disconnect':
        sendDeviceAbsent(device)
        break
      default:
        break
    }
  }

  function onStfMessage(topicFrame, dataFrame) {
    var topic = topicFrame.toString()
    var wrapper, type, message

    try {
      wrapper = wire.Envelope.decode(dataFrame)
    }
    catch (err) {
      return
    }

    type = wire.ReverseMessageType[wrapper.type]
    if (!type || !wire[type]) {
      return
    }

    try {
      message = wire[type].decode(wrapper.message)
    }
    catch (err) {
      return
    }

    var responseChannel = wrapper.channel || topic
    var targetSerial = serialByDeviceChannel[topic] || message.serial
    var device = targetSerial ? devicesBySerial[targetSerial] : null

    switch (type) {
      case 'DeviceRegisteredMessage':
        if (device && !device.ready) {
          device.registered = true
          sendDeviceReady(device)
          sendDeviceIdentity(device)
          device.ready = true
        }
        break
      case 'ProbeMessage':
        if (device) {
          sendDeviceIdentity(device)
        }
        break
      case 'InstallMessage':
        if (device) {
          handleInstall(device, responseChannel, message)
        }
        break
      case 'UninstallMessage':
        if (device) {
          handleUninstall(device, responseChannel, message)
        }
        break
      case 'LaunchActivityMessage':
        if (device) {
          handleLaunch(device, responseChannel, message)
        }
        break
      case 'TouchDownMessage':
        if (device) {
          handleTouchDown(device, message)
        }
        break
      case 'KeyPressMessage':
        if (device) {
          handleKeyPress(device, message)
        }
        break
      case 'TypeMessage':
        if (device) {
          handleType(device, message)
        }
        break
      case 'ScreenCaptureMessage':
        if (device) {
          handleScreenCapture(device, responseChannel)
        }
        break
      default:
        break
    }
  }

  sub.on('message', onStfMessage)

  coordinatorSub.on('message', function(topicFrame, dataFrame) {
    var topic = topicFrame.toString()
    if (topic !== opts.coordinatorEventTopic) {
      return
    }

    var event = parseCoordinatorEvent(dataFrame)
    if (!event) {
      return
    }

    onCoordinatorEvent(event)
  })

  ticker = setInterval(function() {
    var deviceCount = Object.keys(devicesBySerial).length
    log.debug(
      'iOS provider host bridge active; tracked devices=%d'
    , deviceCount
    )
  }, opts.pollInterval)

  lifecycle.observe(function() {
    clearInterval(ticker)
    ;[push, sub, coordinatorSub].forEach(function(sock) {
      try {
        sock.close()
      }
      catch (err) {
        // No-op
      }
    })
  })
}
