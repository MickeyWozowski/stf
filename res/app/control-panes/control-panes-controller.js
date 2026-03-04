/**
* Copyright © 2019 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

module.exports =
  function ControlPanesController($scope, $http, gettext, $routeParams,
    $timeout, $location, DeviceService, GroupService, ControlService,
    StorageService, FatalMessageService, SettingsService) {
    function debugLog(level, message, details) {
      var logger = console && console[level] ? console[level] : console.log
      if (typeof details !== 'undefined') {
        logger.call(console, '[STF-DBG][ControlPanesCtrl] ' + message, details)
      }
      else {
        logger.call(console, '[STF-DBG][ControlPanesCtrl] ' + message)
      }
    }

    debugLog('info', 'controller initialized', {
      serial: $routeParams.serial
    })

    function isIosDevice(device) {
      if (!device) {
        return false
      }
      if (device.platformFamily === 'ios') {
        return true
      }
      return String(device.platform || '').toLowerCase() === 'ios'
    }

    var sharedTabs = [
      {
        title: gettext('Screenshots'),
        icon: 'fa-camera color-skyblue',
        templateUrl: 'control-panes/screenshots/screenshots.pug',
        filters: ['native', 'web']
      },
      {
        title: gettext('Automation'),
        icon: 'fa-road color-lila',
        templateUrl: 'control-panes/automation/automation.pug',
        filters: ['native', 'web']
      },
      {
        title: gettext('Advanced'),
        icon: 'fa-bolt color-brown',
        templateUrl: 'control-panes/advanced/advanced.pug',
        filters: ['native', 'web']
      },
      {
        title: gettext('File Explorer'),
        icon: 'fa-folder-open color-blue',
        templateUrl: 'control-panes/explorer/explorer.pug',
        filters: ['native', 'web']
      },
      {
        title: gettext('Info'),
        icon: 'fa-info color-orange',
        templateUrl: 'control-panes/info/info.pug',
        filters: ['native', 'web']
      }
    ]

    $scope.topTabs = [
      {
        title: gettext('Dashboard'),
        icon: 'fa-dashboard fa-fw color-pink',
        templateUrl: 'control-panes/dashboard/dashboard.pug',
        filters: ['native', 'web']
      }
    ].concat(angular.copy(sharedTabs))

    $scope.belowTabs = [
      {
        title: gettext('Logs'),
        icon: 'fa-list-alt color-red',
        templateUrl: 'control-panes/logs/logs.pug',
        filters: ['native', 'web']
      }
    ].concat(angular.copy(sharedTabs))

    $scope.device = null
    $scope.control = null

    function applyIosUsingFallback(device, reason) {
      if (!isIosDevice(device)) {
        return false
      }

      var isPresent = !!(device && device.present)
      var isOnline = Number(device && device.status) === 3
      var isReady = !!(device && device.ready)
      var hasChannel = !!(device && device.channel)

      if (!device.using && isPresent && isOnline && isReady && hasChannel) {
        device.using = true
        debugLog('warn', 'iOS control-session fallback reapplied', {
          serial: device.serial
        , reason: reason || 'unknown'
        , present: device.present
        , status: device.status
        , ready: device.ready
        })
        return true
      }

      return false
    }

    function inviteWithTimeout(device, timeoutMs) {
      return new Promise(function(resolve, reject) {
        var settled = false
        var timer = setTimeout(function() {
          if (settled) {
            return
          }
          settled = true
          reject(new Error('Group invite timeout after ' + timeoutMs + 'ms'))
        }, timeoutMs)

        GroupService.invite(device)
          .then(function(result) {
            if (settled) {
              return
            }
            settled = true
            clearTimeout(timer)
            resolve(result)
          })
          .catch(function(err) {
            if (settled) {
              return
            }
            settled = true
            clearTimeout(timer)
            reject(err)
          })
      })
    }

    // TODO: Move this out to Ctrl.resolve
    function getDevice(serial) {
      debugLog('info', 'getDevice start', {
        serial: serial
      })
      DeviceService.get(serial, $scope)
        .then(function(device) {
          debugLog('info', 'DeviceService.get resolved', {
            serial: device && device.serial
          , platform: device && device.platform
          , platformFamily: device && device.platformFamily
          , present: device && device.present
          , status: device && device.status
          , ready: device && device.ready
          , usable: device && device.usable
          , using: device && device.using
          , channel: device && device.channel
          })

          debugLog('info', 'GroupService.invite begin', {
            serial: device && device.serial
          , usable: device && device.usable
          , isIos: isIosDevice(device)
          })

          var invitePromise = isIosDevice(device) ?
            inviteWithTimeout(device, 5000) :
            GroupService.invite(device)

          return invitePromise
            .then(function(invitedDevice) {
              debugLog('info', 'GroupService.invite resolved', {
                serial: invitedDevice && invitedDevice.serial
              , using: invitedDevice && invitedDevice.using
              , owner: invitedDevice && invitedDevice.owner
              , channel: invitedDevice && invitedDevice.channel
              })
              return invitedDevice
            })
            .catch(function(err) {
              debugLog('warn', 'GroupService.invite rejected', {
                serial: device && device.serial
              , isIos: isIosDevice(device)
              , message: err && err.message
              })
              // iOS host-bridge can intermittently fail group-invite with
              // 504 while the device channel is still controllable.
              if (isIosDevice(device)) {
                device.using = true
                debugLog('warn', 'iOS invite fallback applied; forcing using=true', {
                  serial: device.serial
                , channel: device.channel
                })
                return device
              }
              throw err
            })
        })
        .then(function(device) {
          applyIosUsingFallback(device, 'after_get_device')

          debugLog('info', 'setting scope.device and creating control', {
            serial: device && device.serial
          , using: device && device.using
          , channel: device && device.channel
          })
          $scope.device = device
          $scope.control = ControlService.create(device, device.channel)

          // TODO: Change title, flickers too much on Chrome
          // $rootScope.pageTitle = device.name

          SettingsService.set('lastUsedDevice', serial)

          debugLog('info', 'getDevice complete', {
            serial: serial
          })
          return device
        })
        .catch(function(err) {
          debugLog('error', 'getDevice failed; redirecting to root', {
            serial: serial
          , message: err && err.message
          })
          $timeout(function() {
            $location.path('/')
          })
        })
    }

    getDevice($routeParams.serial)

    $scope.$watch('device.state', function(newValue, oldValue) {
      if (newValue !== oldValue) {
/*************** fix bug: it seems automation state was forgotten ? *************/
        if (oldValue === 'using' || oldValue === 'automation') {
/******************************************************************************/
          FatalMessageService.open($scope.device, false)
        }
      }
    }, true)

    $scope.$watch(function() {
      if (!$scope.device) {
        return ''
      }

      return [
        $scope.device.serial || ''
      , $scope.device.using ? '1' : '0'
      , $scope.device.present ? '1' : '0'
      , String($scope.device.status || '')
      , $scope.device.ready ? '1' : '0'
      , $scope.device.channel || ''
      , $scope.device.platformFamily || ''
      , $scope.device.platform || ''
      ].join('|')
    }, function(newValue, oldValue) {
      if (newValue !== oldValue) {
        applyIosUsingFallback($scope.device, 'device_watch')
      }
    })

  }
