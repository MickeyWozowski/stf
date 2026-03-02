var Promise = require('bluebird')

var dbapi = require('../../db/api')
var lifecycle = require('../../util/lifecycle')
var logger = require('../../util/logger')
var manifestUtil = require('./manifest')
var policy = require('./policy')
var executors = require('./executors')

module.exports = function(options) {
  function toBool(value, defaultValue) {
    if (typeof value === 'boolean') {
      return value
    }
    if (typeof value === 'number') {
      return value !== 0
    }
    if (typeof value === 'string') {
      var normalized = value.trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].indexOf(normalized) !== -1) {
        return true
      }
      if (['0', 'false', 'no', 'off'].indexOf(normalized) !== -1) {
        return false
      }
    }
    return !!defaultValue
  }

  function toList(value) {
    if (!value) {
      return []
    }
    if (Array.isArray(value)) {
      return value.filter(Boolean)
    }
    return String(value).split(',').map(function(item) {
      return item.trim()
    }).filter(Boolean)
  }

  var opts = Object.assign({
      name: null
    , provider: null
    , pollInterval: 3000
    , executionMode: 'dry-run'
    , executionBackend: 'mac-dev-local'
    , allowMacDevLocal: toBool(process.env.STF_FLASH_SAMSUNG_ENABLE_MAC_DEV_LOCAL, false)
    , allowWrites: toBool(process.env.STF_FLASH_SAMSUNG_ALLOW_WRITES, false)
    , environmentProfile: process.env.STF_FLASH_SAMSUNG_ENV || process.env.NODE_ENV || 'development'
    , allowedSerials: toList(process.env.STF_FLASH_SAMSUNG_ALLOWED_SERIALS)
    , allowedPackagePrefixes: toList(process.env.STF_FLASH_SAMSUNG_ALLOWED_PACKAGE_PREFIXES)
    , confirmationPhrase: process.env.STF_FLASH_SAMSUNG_CONFIRMATION_PHRASE || 'I_UNDERSTAND_THIS_WILL_FLASH'
    , requireAdmin: false
    , logLineLimit: 1200
    }
  , options || {})

  opts.allowMacDevLocal = toBool(
    typeof opts.allowMacDevLocal === 'undefined' ?
      process.env.STF_FLASH_SAMSUNG_ENABLE_MAC_DEV_LOCAL :
      opts.allowMacDevLocal
  , false)
  opts.allowWrites = toBool(
    typeof opts.allowWrites === 'undefined' ?
      process.env.STF_FLASH_SAMSUNG_ALLOW_WRITES :
      opts.allowWrites
  , false)
  opts.environmentProfile =
    opts.environmentProfile ||
    process.env.STF_FLASH_SAMSUNG_ENV ||
    process.env.NODE_ENV ||
    'development'
  opts.allowedSerials = toList(
    opts.allowedSerials && opts.allowedSerials.length ?
      opts.allowedSerials :
      process.env.STF_FLASH_SAMSUNG_ALLOWED_SERIALS
  )
  opts.allowedPackagePrefixes = toList(
    opts.allowedPackagePrefixes && opts.allowedPackagePrefixes.length ?
      opts.allowedPackagePrefixes :
      process.env.STF_FLASH_SAMSUNG_ALLOWED_PACKAGE_PREFIXES
  )

  var log = logger.createLogger('flash-samsung')
  var timer = null
  var running = false

  if (opts.name) {
    logger.setGlobalIdentifier(opts.name)
  }

  function appendLog(jobId, line) {
    return dbapi.appendFlashJobLog(jobId, line, opts.logLineLimit)
      .catch(function(err) {
        log.warn('Failed to append flash job log line: %s', err.message || err)
      })
  }

  function failJob(job, err, step) {
    var detail = err && err.message ? err.message : String(err)
    var code = err && err.code ? err.code : 'FLASH_WORKER_ERROR'
    var result = {
        success: false
      , code: code
      , detail: detail
      }

    if (err && err.details) {
      result.meta = err.details
    }

    log.error('Flash job "%s" failed: %s', job.id, detail)
    return appendLog(job.id, {
      line: 'error: ' + detail
    , level: 'error'
    , eventType: 'status'
    , step: step || 'failed'
    })
      .then(function() {
        return dbapi.setFlashJobStatus(job.id, 'failed', {
      step: step || 'failed'
    , progress: 100
    , message: detail
    , result: result
    , finishedAt: new Date()
        })
      })
  }

  function emitExecutorEvent(job, event) {
    if (!event) {
      return
    }

    if (event.type === 'status') {
      return appendLog(job.id, {
          line: 'status: ' + event.message
        , level: event.level || 'info'
        , eventType: 'status'
        , step: event.step || null
        })
    }

    if (event.type === 'log') {
      return appendLog(job.id, {
          line: event.line || ''
        , level: event.level || 'info'
        , eventType: event.eventType || 'log'
        , stream: event.stream || null
        , commandId: event.commandId || null
        , command: event.command || null
        , args: Array.isArray(event.args) ? event.args : null
        , pid: event.pid
        , phase: event.phase || null
        , code: event.code
        , signal: event.signal || null
        , durationMs: event.durationMs
        , step: event.step || null
        , actionType: event.actionType || null
        , partition: event.partition || null
        , artifactId: event.artifactId || null
        , at: event.at || null
        })
    }

    return appendLog(job.id, {
        line: 'event: ' + JSON.stringify(event)
      , level: 'info'
      , eventType: event.type || 'event'
      })
  }

  function getActor(job) {
    return dbapi.loadUser(job.createdBy)
      .then(function(actor) {
        if (!actor) {
          throw new Error('Flash actor user not found: ' + job.createdBy)
        }
        return actor
      })
  }

  function loadManifestIfNeeded(job, executionMode) {
    var hasInlineManifest = job.metadata && job.metadata.manifest
    var hasManifestPath = job.metadata && job.metadata.manifestPath
    var mustLoad = executionMode === 'execute' || hasInlineManifest || hasManifestPath

    if (!mustLoad) {
      return Promise.resolve(null)
    }

    return Promise.resolve(manifestUtil.parseManifest(job))
      .then(function(result) {
        var normalized = manifestUtil.normalizeManifest(result.manifest)
        return manifestUtil.validateChecksums(normalized, job.metadata || {}, result.sourcePath)
      })
  }

  function processJob(job) {
    var device = null
    var actor = null
    var manifest = null
    var policyState = null
    var executor = null
    var executionMode = job.executionMode || opts.executionMode
    var executionBackend = job.executionBackend || opts.executionBackend
    var metadata = job.metadata || {}
    var streamedEventCount = 0

    log.info(
      'Processing flash job "%s" for device "%s" (%s mode, backend=%s)',
      job.id,
      job.deviceSerial,
      executionMode,
      executionBackend
    )

    return dbapi.updateFlashJob(job.id, {
      executionMode: executionMode
    , executionBackend: executionBackend
    })
      .then(function() {
        return dbapi.setFlashJobStatus(job.id, 'validating', {
      step: 'validating'
    , progress: 10
    , message: 'Validating target device and manifest inputs'
        })
      })
      .then(function() {
        if (!job.packageRef) {
          throw new Error('Missing packageRef in flash job')
        }
        return dbapi.loadDeviceBySerial(job.deviceSerial)
      })
      .then(function(foundDevice) {
        device = foundDevice
        if (!device) {
          throw new Error('Device not found in STF database')
        }
        return getActor(job)
      })
      .then(function(foundActor) {
        actor = foundActor
        return loadManifestIfNeeded(job, executionMode)
      })
      .then(function(loadedManifest) {
        manifest = loadedManifest
        if (manifest) {
          manifestUtil.validateCompatibility(device, metadata, manifest)
        }
      })
      .then(function() {
        if (executionMode === 'dry-run') {
          return dbapi.setFlashJobStatus(job.id, 'succeeded', {
            step: 'completed'
          , progress: 100
          , message: 'Dry-run complete: no device flashing command was executed'
          , result: {
              success: true
            , code: 'DRY_RUN'
            , detail: 'Workflow path validated without writing partitions'
            , backend: executionBackend
            }
          , finishedAt: new Date()
          })
        }

        if (executionMode !== 'execute') {
          throw new Error('Unsupported execution mode: ' + executionMode)
        }

        policyState = policy.evaluate(
          Object.assign({}, job, {
            executionBackend: executionBackend
          }),
          device,
          actor,
          {
            allowMacDevLocal: opts.allowMacDevLocal
          , allowWrites: opts.allowWrites
          , environmentProfile: opts.environmentProfile
          , allowedSerials: opts.allowedSerials
          , allowedPackagePrefixes: opts.allowedPackagePrefixes
          , confirmationPhrase: opts.confirmationPhrase
          , requireAdmin: opts.requireAdmin
          }
        )

        executor = executors.createExecutor(executionBackend, {
          provider: opts.provider
        , workerName: opts.name
        })

        return dbapi.setFlashJobStatus(job.id, 'preparing', {
          step: 'prepare'
        , progress: 30
        , message: 'Preparing Samsung execution backend'
        })
      })
      .then(function() {
        if (executionMode === 'dry-run') {
          return null
        }

        return executor.prepare({
            job: job
          , device: device
          , manifest: manifest
          , allowWrites: policyState.allowWrites
          , simulate: toBool(metadata.simulate, false)
          }, function(event) {
            streamedEventCount += 1
            emitExecutorEvent(job, event)
          })
      })
      .then(function() {
        if (executionMode === 'dry-run') {
          return null
        }

        return dbapi.setFlashJobStatus(job.id, 'flashing', {
          step: 'flash'
        , progress: 60
        , message: 'Executing Samsung flash actions'
        })
      })
      .then(function() {
        if (executionMode === 'dry-run') {
          return null
        }

        return executor.flash({
            job: job
          , device: device
          , manifest: manifest
          , allowWrites: policyState.allowWrites
          , simulate: toBool(metadata.simulate, false)
          }, function(event) {
            streamedEventCount += 1
            emitExecutorEvent(job, event)
          })
      })
      .then(function() {
        if (executionMode === 'dry-run') {
          return null
        }

        return dbapi.setFlashJobStatus(job.id, 'verifying', {
          step: 'verify'
        , progress: 85
        , message: 'Running post-flash verification'
        })
      })
      .then(function() {
        if (executionMode === 'dry-run') {
          return null
        }

        return executor.verify({
            job: job
          , device: device
          , manifest: manifest
          , allowWrites: policyState.allowWrites
          , simulate: toBool(metadata.simulate, false)
          }, function(event) {
            streamedEventCount += 1
            emitExecutorEvent(job, event)
          })
      })
      .then(function() {
        if (executionMode === 'dry-run') {
          return null
        }

        var finalMessage = 'Samsung execution completed on mac-dev-local backend'
        if (policyState && policyState.warnings && policyState.warnings.length) {
          finalMessage = policyState.warnings[0]
        }

        return dbapi.setFlashJobStatus(job.id, 'succeeded', {
          step: 'completed'
        , progress: 100
        , message: finalMessage
        , result: {
            success: true
          , code: policyState.auditMarker || 'EXECUTED'
          , detail: 'Samsung executor flow finished'
          , backend: executionBackend
          , environmentProfile: policyState.environmentProfile
          , warnings: policyState.warnings || []
          }
        , finishedAt: new Date()
        })
      })
      .then(function() {
        if (!executor || typeof executor.collectLogs !== 'function') {
          return null
        }
        if (streamedEventCount > 0) {
          return null
        }
        return Promise.map(executor.collectLogs(), function(line) {
            return appendLog(job.id, '[buffered] ' + line)
          }, {concurrency: 1})
          .catch(function() {
            return null
          })
      })
      .catch(function(err) {
        return failJob(job, err, executionMode === 'dry-run' ? 'validation' : 'execution')
      })
  }

  function tick() {
    if (running) {
      return Promise.resolve()
    }

    running = true

    return dbapi.claimNextQueuedFlashJob(opts.provider, opts.name)
      .then(function(job) {
        if (!job) {
          return null
        }
        return processJob(job)
      })
      .catch(function(err) {
        log.error('Flash worker loop error: %s', err.stack || err.message || err)
      })
      .finally(function() {
        running = false
      })
  }

  log.info(
    'Samsung flash worker started (provider="%s", mode="%s", backend="%s", pollInterval=%dms)',
    opts.provider || 'any',
    opts.executionMode,
    opts.executionBackend,
    opts.pollInterval
  )

  timer = setInterval(tick, opts.pollInterval)
  tick()

  lifecycle.observe(function() {
    if (timer) {
      clearInterval(timer)
    }
  })
}
