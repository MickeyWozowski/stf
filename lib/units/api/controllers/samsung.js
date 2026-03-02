/**
* Copyright © 2026 contains code contributed by OpenAI - Licensed under the Apache license 2.0
**/

var dbapi = require('../../../db/api')
var logger = require('../../../util/logger')

var log = logger.createLogger('api:controllers:samsung')

function toString(value) {
  if (typeof value !== 'string') {
    return null
  }
  var normalized = value.trim()
  return normalized.length ? normalized : null
}

function toNumber(value, fallback) {
  var parsed = Number(value)
  if (!isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.floor(parsed)
}

function toBool(value, fallback) {
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
  return !!fallback
}

function normalizeMetadata(payload) {
  var metadata = Object.assign({}, payload.metadata || {})

  if (toString(payload.manifestPath)) {
    metadata.manifestPath = toString(payload.manifestPath)
  }

  if (toString(payload.packageBasePath)) {
    metadata.packageBasePath = toString(payload.packageBasePath)
  }

  if (toString(payload.destructiveConfirmation)) {
    metadata.destructiveConfirmation = toString(payload.destructiveConfirmation)
  }

  if (typeof payload.simulate !== 'undefined') {
    metadata.simulate = payload.simulate === true
  }

  if (payload.deviceInfo && typeof payload.deviceInfo === 'object') {
    metadata.deviceInfo = Object.assign({}, metadata.deviceInfo || {}, payload.deviceInfo)
  }

  return metadata
}

function listFlashJobs(req, res) {
  var params = req.swagger.params
  var status = toString(params.status.value)
  var serial = toString(params.serial.value)
  var createdBy = toString(params.createdBy.value)
  var limit = toNumber(params.limit.value, 50)
  var includeLogs = toBool(params.includeLogs.value, false)

  dbapi.listFlashJobs({
      status: status
    , deviceSerial: serial
    , createdBy: createdBy
    , limit: limit
    , includeLogs: includeLogs
    })
    .then(function(jobs) {
      res.json({
          success: true
        , description: 'Samsung flash jobs information'
        , jobs: jobs
        })
    })
    .catch(function(err) {
      log.error('Failed to list Samsung flash jobs: %s', err.stack || err.message || err)
      res.status(500).json({
          success: false
        , description: 'Internal Server Error'
        })
    })
}

function getFlashJob(req, res) {
  var id = req.swagger.params.id.value

  dbapi.getFlashJob(id)
    .then(function(job) {
      if (!job) {
        return res.status(404).json({
            success: false
          , description: 'Flash job not found'
          })
      }

      res.json({
          success: true
        , description: 'Samsung flash job information'
        , job: job
        })
    })
    .catch(function(err) {
      log.error('Failed to get Samsung flash job "%s": %s', id, err.stack || err.message || err)
      res.status(500).json({
          success: false
        , description: 'Internal Server Error'
        })
    })
}

function createFlashJob(req, res) {
  var payload = req.swagger.params.job.value || {}
  var serial = toString(payload.serial || payload.deviceSerial)
  var packageRef = toString(payload.packageRef) || 'firmware://sm-t830/xar/u5'
  var executionMode = payload.executionMode === 'execute' ? 'execute' : 'dry-run'
  var executionBackend = toString(payload.executionBackend) || 'mac-dev-local'
  var metadata = normalizeMetadata(payload)

  if (!serial) {
    return res.status(400).json({
        success: false
      , description: 'Missing required field: serial'
      })
  }

  dbapi.loadDeviceBySerial(serial)
    .then(function(device) {
      if (!device) {
        return res.status(404).json({
            success: false
          , description: 'Device not found in STF database'
          })
      }

      return dbapi.createFlashJob({
          deviceSerial: serial
        , provider: toString(payload.provider) || (device.provider && device.provider.name) || null
        , createdBy: req.user.email
        , packageRef: packageRef
        , manifestVersion: toString(payload.manifestVersion)
        , targetBuild: toString(payload.targetBuild)
        , message: toString(payload.message) || 'Flash job queued from Samsung API'
        , executionMode: executionMode
        , executionBackend: executionBackend
        , metadata: metadata
        })
        .then(function(job) {
          res.status(201).json({
              success: true
            , description: 'Samsung flash job created'
            , job: job
            })
        })
    })
    .catch(function(err) {
      log.error('Failed to create Samsung flash job: %s', err.stack || err.message || err)
      res.status(500).json({
          success: false
        , description: 'Internal Server Error'
        })
    })
}

function cancelFlashJob(req, res) {
  var id = req.swagger.params.id.value
  var payload = req.swagger.params.cancel.value || {}
  var reason = toString(payload.reason) || 'Canceled from Samsung API'

  dbapi.getFlashJob(id)
    .then(function(job) {
      if (!job) {
        return res.status(404).json({
            success: false
          , description: 'Flash job not found'
          })
      }

      return dbapi.cancelFlashJob(id, req.user.email, reason)
        .then(function(canceledJob) {
          if (!canceledJob) {
            return res.status(409).json({
                success: false
              , description: 'Flash job is not in a cancellable state'
              })
          }

          res.json({
              success: true
            , description: 'Samsung flash job canceled'
            , job: canceledJob
            })
        })
    })
    .catch(function(err) {
      log.error('Failed to cancel Samsung flash job "%s": %s', id, err.stack || err.message || err)
      res.status(500).json({
          success: false
        , description: 'Internal Server Error'
        })
    })
}

function getFlashServiceStatus(req, res) {
  var provider = toString(req.swagger.params.provider.value)

  dbapi.getSamsungFlashServiceStatus(provider)
    .then(function(summary) {
      res.json({
          success: true
        , description: 'Samsung flash service status'
        , status: summary
        })
    })
    .catch(function(err) {
      log.error('Failed to get Samsung flash service status: %s', err.stack || err.message || err)
      res.status(500).json({
          success: false
        , description: 'Internal Server Error'
        })
    })
}

module.exports = {
    listFlashJobs: listFlashJobs
  , getFlashJob: getFlashJob
  , createFlashJob: createFlashJob
  , cancelFlashJob: cancelFlashJob
  , getFlashServiceStatus: getFlashServiceStatus
}
