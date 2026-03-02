/**
* Copyright © 2019-2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

var oboe = require('oboe')
var _ = require('lodash')
var EventEmitter = require('eventemitter3')
let Promise = require('bluebird')

module.exports = function DeviceServiceFactory(
  $http
, socket
, EnhanceDeviceService
, CommonService
, TransactionService
) {
  var deviceService = {}

  function Tracker($scope, options) {
    var devices = []
    var devicesBySerial = Object.create(null)
    var scopedSocket = socket.scoped($scope)
    var digestTimer, lastDigest

    $scope.$on('$destroy', function() {
      clearTimeout(digestTimer)
    })

    function digest() {
      // Not great. Consider something else
      if (!$scope.$$phase) {
        $scope.$digest()
      }

      lastDigest = Date.now()
      digestTimer = null
    }

    function notify(event) {
      if (!options.digest) {
        return
      }

      if (event.important) {
        // Handle important updates immediately.
        //digest()
        window.requestAnimationFrame(digest)
      }
      else {
        if (!digestTimer) {
          var delta = Date.now() - lastDigest
          if (delta > 1000) {
            // It's been a while since the last update, so let's just update
            // right now even though it's low priority.
            digest()
          }
          else {
            // It hasn't been long since the last update. Let's wait for a
            // while so that the UI doesn't get stressed out.
            digestTimer = setTimeout(digest, delta)
          }
        }
      }
    }

    function sync(data) {
      if (data.kind === 'service') {
        data.present = typeof data.present === 'undefined' ? true : !!data.present
        data.usable = false
        data.using = false
        EnhanceDeviceService.enhance(data)
        return
      }

      // usable IF device is physically present AND device is online AND
      // preparations are ready AND the device has no owner or we are the
      // owner
      data.usable = data.present && data.status === 3 && data.ready &&
        (!data.owner || data.using)

      // Make sure we don't mistakenly think we still have the device
      if (!data.usable || !data.owner) {
        data.using = false
      }

      EnhanceDeviceService.enhance(data)
    }

    function get(data) {
      return devices[devicesBySerial[data.serial]]
    }

    var insert = function insert(data) {
      devicesBySerial[data.serial] = devices.push(data) - 1
      sync(data)
      this.emit('add', data)
    }.bind(this)

    var modify = function modify(data, newData) {
      _.merge(data, newData, function(a, b) {
        // New Arrays overwrite old Arrays
        if (_.isArray(b)) {
          return b
        }
      })
      sync(data)
      this.emit('change', data)
    }.bind(this)

    var remove = function remove(data) {
      var index = devicesBySerial[data.serial]
      if (index >= 0) {
        devices.splice(index, 1)
        delete devicesBySerial[data.serial]
        for (var serial in devicesBySerial) {
          if (devicesBySerial[serial] > index) {
            devicesBySerial[serial]--
          }
        }
        sync(data)
        this.emit('remove', data)
      }
    }.bind(this)

    function fetch(data) {
      deviceService.load(data.serial)
        .then(function(device) {
          return changeListener({
            important: true
          , data: device
          })
        })
        .catch(function() {})
    }

    function addListener(event) {
      var device = get(event.data)
      if (device) {
        modify(device, event.data)
        notify(event)
      }
      else {
        if (options.filter(event.data)) {
          insert(event.data)
          notify(event)
        }
      }
    }

    function changeListener(event) {
      var device = get(event.data)
      if (device) {
        if (event.data.likelyLeaveReason === 'status_change' &&
            device.statusTimeStamp > event.data.statusTimeStamp) {
          return
        }
        modify(device, event.data)
        if (!options.filter(device)) {
          remove(device)
        }
        notify(event)
      }

      /** code removed to avoid to show forbidden devices in user view!
      else {
        if (options.filter(event.data)) {
          insert(event.data)
          // We've only got partial data
          fetch(event.data)
          notify(event)
        }
      }
      **/
    }

    scopedSocket.on('device.add', addListener)
    scopedSocket.on('device.remove', changeListener)
    scopedSocket.on('device.change', changeListener)

    this.add = function(device) {
      addListener({
        important: true
      , data: device
      })
    }

    this.devices = devices

    function addGroupDevicesListener(event) {
      return Promise.map(event.devices, function(serial) {
        return deviceService.load(serial).then(function(device) {
          return device
        })
      })
      .then(function(_devices) {
        _devices.forEach(function(device) {
          if (device && typeof devicesBySerial[device.serial] === 'undefined') {
            insert(device)
            notify(event)
          }
        })
      })
    }

    function removeGroupDevicesListener(event) {
      event.devices.forEach(function(serial) {
        if (typeof devicesBySerial[serial] !== 'undefined') {
          remove(devices[devicesBySerial[serial]])
          notify(event)
        }
      })
    }

    function updateGroupDeviceListener(event) {
      let device = get(event.data)
      if (device) {
        modify(device, event.data)
        notify(event)
      }
    }

    scopedSocket.on('device.addGroupDevices', addGroupDevicesListener)
    scopedSocket.on('device.removeGroupDevices', removeGroupDevicesListener)
    scopedSocket.on('device.updateGroupDevice', updateGroupDeviceListener)
  }

  Tracker.prototype = new EventEmitter()

  deviceService.getSamsungFlashServiceStatus = function(provider) {
    return $http.get('/api/v1/samsung/flash-service/status', {
      params: {
        provider: provider || undefined
      }
    })
      .then(function(result) {
        if (result && result.data && result.data.status) {
          return result.data.status
        }
        return {}
      })
      .catch(function() {
        // Keep websocket fallback for mixed deployments while API route propagates.
        var tx = TransactionService.create({
          serial: 'svc:samsung-flash'
        })

        socket.emit('service.flash-samsung.status', '*ALL', tx.channel, {
          provider: provider || null
        })

        return tx.promise
          .then(function(wsResult) {
            return wsResult.lastData || {}
          })
      })
  }

  deviceService.listSamsungFlashJobs = function(options) {
    var opts = options || {}
    return $http.get('/api/v1/samsung/flash-jobs', {
      params: {
          status: opts.status || undefined
        , serial: opts.serial || opts.deviceSerial || undefined
        , createdBy: opts.createdBy || undefined
        , limit: opts.limit || undefined
        , includeLogs: opts.includeLogs === true
      }
    })
      .then(function(result) {
        return result && result.data && Array.isArray(result.data.jobs) ? result.data.jobs : []
      })
  }

  deviceService.getSamsungFlashJob = function(id) {
    return $http.get('/api/v1/samsung/flash-jobs/' + id)
      .then(function(result) {
        return result && result.data ? result.data.job : null
      })
  }

  deviceService.createSamsungFlashJob = function(payload) {
    return $http.post('/api/v1/samsung/flash-jobs', payload || {})
      .then(function(result) {
        return result && result.data ? result.data.job : null
      })
  }

  deviceService.cancelSamsungFlashJob = function(id, reason) {
    return $http.post('/api/v1/samsung/flash-jobs/' + id + '/cancel', {
      reason: reason || 'Canceled from Samsung Updater'
    })
      .then(function(result) {
        return result && result.data ? result.data.job : null
      })
  }

  deviceService.trackAll = function($scope) {
    var serviceSerial = 'svc:samsung-flash'
    var serviceProviderLabel = 'flash-service'
    var serviceOwner = {
      email: 'service@stf.local'
    , name: 'Samsung Updater Worker'
    }
    var serviceGroup = {
      id: 'engineering-services'
    , name: 'Engineering Services'
    , class: 'service'
    , origin: 'engineering-services'
    , owner: {
        email: 'service@stf.local'
      , name: 'STF Service'
      }
    , originName: 'Engineering Services'
    }
    var tracker = new Tracker($scope, {
      filter: function() {
        return true
      }
    , digest: false
    })

    function findServiceDevice() {
      for (var i = 0, l = tracker.devices.length; i < l; ++i) {
        if (tracker.devices[i].serial === serviceSerial) {
          return tracker.devices[i]
        }
      }
      return null
    }

    function toIsoDate(value) {
      if (!value) {
        return null
      }
      var date = new Date(value)
      if (isNaN(date.getTime())) {
        return null
      }
      return date.toISOString()
    }

    function titleCase(value) {
      if (!value) {
        return 'Unknown'
      }
      return String(value)
        .split('_')
        .join(' ')
        .replace(/\b\w/g, function(ch) {
          return ch.toUpperCase()
        })
    }

    function ensureServiceDevice() {
      var service = findServiceDevice()
      if (service) {
        return service
      }

      service = {
          serial: serviceSerial
        , kind: 'service'
        , serviceType: 'samsung-flash'
        , image: '_default.jpg'
        , manufacturer: 'STF'
        , model: 'Samsung Updater Service'
        , name: 'Samsung Updater'
        , marketName: 'Samsung Updater'
        , version: 'mac-dev-local'
        , operator: ''
        , notes: 'Loading Samsung updater service status...'
        , provider: {
            name: serviceProviderLabel
          }
        , group: serviceGroup
        , owner: null
        , using: false
        , ready: true
        , present: true
        , status: 3
        , serviceInfo: {
            operatingState: 'idle'
          , queue: {
              queued: 0
            , active: 0
            , pending: 0
            , failed: 0
            , succeeded: 0
            , canceled: 0
            }
          , latestJob: null
          }
        }

      tracker.add(service)
      return service
    }

    function applyServiceSummary(summary, hasError) {
      var service = ensureServiceDevice()
      var queue = summary && summary.queue ? summary.queue : {}
      var latest = summary ? summary.latestJob : null
      var operatingState = summary && summary.operatingState ? summary.operatingState : 'unknown'
      var latestLabel = latest && latest.id ?
        (latest.status + ' #' + latest.id.slice(0, 8)) :
        'none'

      service.kind = 'service'
      service.serviceType = 'samsung-flash'
      service.provider = {
        name: summary && summary.provider ? summary.provider : serviceProviderLabel
      }

      service.present = true
      service.ready = true
      service.owner = null
      service.using = false

      if (hasError) {
        service.status = 2
        service.ready = false
      }
      else if (operatingState === 'degraded') {
        service.status = 1
        service.ready = false
      }
      else if ((queue.active || 0) > 0) {
        service.status = 3
        service.owner = serviceOwner
      }
      else if ((queue.queued || 0) > 0) {
        service.status = 3
      }
      else {
        service.status = 3
      }

      service.version = latest && latest.executionBackend ?
        (latest.executionBackend + ' / ' + (latest.executionMode || 'n/a')) :
        'mac-dev-local / dry-run'

      service.notes = [
        'state=' + operatingState
      , 'queued=' + (queue.queued || 0)
      , 'active=' + (queue.active || 0)
      , 'failed=' + (queue.failed || 0)
      , 'latest=' + latestLabel
      ].join(' | ')

      service.releasedAt = latest && latest.updatedAt ? toIsoDate(latest.updatedAt) : null
      service.serviceInfo = summary || {
        operatingState: operatingState
      , queue: queue
      , latestJob: latest || null
      }

      EnhanceDeviceService.enhance(service)
      service.enhancedStateAction = titleCase(operatingState) + ' | Q' +
        (queue.queued || 0) + '/A' + (queue.active || 0)
      service.enhancedStatePassive = titleCase(operatingState)
      service.usable = false
      service.using = false

      tracker.emit('change', service)
    }

    var pollRunning = false

    function refreshSamsungFlashService() {
      if (pollRunning) {
        return
      }

      pollRunning = true
      deviceService.getSamsungFlashServiceStatus()
        .then(function(summary) {
          applyServiceSummary(summary, false)
        })
        .catch(function(err) {
          applyServiceSummary({
              provider: serviceProviderLabel
            , operatingState: 'error'
            , queue: {
                queued: 0
              , active: 0
              , pending: 0
              , failed: 0
              , succeeded: 0
              , canceled: 0
              }
            , latestJob: {
                status: 'error'
              , id: 'n/a'
              , updatedAt: new Date().toISOString()
              , message: err && err.message ? err.message : String(err)
              }
            }
          , true
          )
        })
        .finally(function() {
          pollRunning = false
        })
    }

    ensureServiceDevice()

    var servicePollTimer = setInterval(refreshSamsungFlashService, 2000)
    $scope.$on('$destroy', function() {
      clearInterval(servicePollTimer)
    })

    oboe(CommonService.getBaseUrl() + '/api/v1/devices')
      .node('devices[*]', function(device) {
        tracker.add(device)
      })

    refreshSamsungFlashService()

    return tracker
  }

  deviceService.trackGroup = function($scope) {
    var tracker = new Tracker($scope, {
      filter: function(device) {
        return device.using
      }
    , digest: true
    })

    oboe(CommonService.getBaseUrl() + '/api/v1/user/devices')
      .node('devices[*]', function(device) {
        tracker.add(device)
      })

    return tracker
  }

  deviceService.load = function(serial) {
    return $http.get('/api/v1/devices/' + serial)
      .then(function(response) {
        return response.data.device
      })
  }

  deviceService.get = function(serial, $scope) {
    var tracker = new Tracker($scope, {
      filter: function(device) {
        return device.serial === serial
      }
    , digest: true
    })

    return deviceService.load(serial)
      .then(function(device) {
        tracker.add(device)
        return device
      })
  }

  deviceService.updateNote = function(serial, note) {
    socket.emit('device.note', {
      serial: serial,
      note: note
    })
  }

  return deviceService
}
