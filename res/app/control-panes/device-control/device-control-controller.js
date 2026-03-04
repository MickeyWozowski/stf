var _ = require('lodash')

module.exports = function DeviceControlCtrl($scope, DeviceService, GroupService,
  $location, $routeParams, $timeout, $window, $rootScope, LogcatService) {
  function debugLog(level, message, details) {
    var logger = console && console[level] ? console[level] : console.log
    var prefix = '[STF-DBG][DeviceControlCtrl] '
    if (typeof details !== 'undefined') {
      logger.call(console, prefix + message, details)
    }
    else {
      logger.call(console, prefix + message)
    }
  }

  $scope.showScreen = true

  $scope.groupTracker = DeviceService.trackGroup($scope)

  $scope.groupDevices = $scope.groupTracker.devices

  debugLog('info', 'controller initialized')
  var selectedSerial = $routeParams && $routeParams.serial || null

  function buildStartupSteps() {
    return [
      {
        id: 'selected'
      , label: 'Device selected'
      , state: 'pending'
      , detail: 'Waiting for iOS device context'
      }
    , {
        id: 'ready'
      , label: 'Control channel ready'
      , state: 'pending'
      , detail: 'Waiting for STF ready state'
      }
    , {
        id: 'identity'
      , label: 'iOS identity received'
      , state: 'pending'
      , detail: 'Waiting for UDID/product metadata'
      }
    , {
        id: 'endpoint'
      , label: 'Video endpoint resolved'
      , state: 'pending'
      , detail: 'Waiting for websocket URL/video port'
      }
    , {
        id: 'websocket'
      , label: 'Video websocket connected'
      , state: 'pending'
      , detail: 'Waiting for websocket open'
      }
    , {
        id: 'frame'
      , label: 'First frame received'
      , state: 'pending'
      , detail: 'Waiting for video frame data'
      }
    ]
  }

  function createIosStartupState(serial) {
    return {
      serial: serial || null
    , active: false
      , expanded: true
      , completed: false
      , hasError: false
      , steps: buildStartupSteps()
      , diagnostics: {
        displayUrl: null
      , socketUrl: null
      , videoPort: null
      , socketState: 'connecting'
      , openedAt: null
      , closedAt: null
      , errorAt: null
      , closeCode: null
      , closeReason: null
      , firstFrameAt: null
      , firstVisibleFrameAt: null
      , lastFrameAt: null
      , frameCount: 0
      , renderedFrameCount: 0
      , skippedFrameCount: 0
      , lastRenderedAt: null
      , lastBlobSize: 0
      , lastAverageLuma: null
      , darkFrameCount: 0
      , lastEventType: null
      , lastEventAt: null
      , lastErrorMessage: null
      , lastErrorCode: null
      , lastErrorStatus: null
      , reconnectAttempts: 0
      , reconnectDelayMs: null
      , reconnectReason: null
      }
    }
  }

  function findTrackedDevice(serial) {
    if (!serial || !$scope.groupDevices) {
      return null
    }
    for (var i = 0; i < $scope.groupDevices.length; i += 1) {
      if ($scope.groupDevices[i] && $scope.groupDevices[i].serial === serial) {
        return $scope.groupDevices[i]
      }
    }
    return null
  }

  function shouldOptimisticallyShowIosStartup(serial) {
    if (!serial) {
      return false
    }
    var tracked = findTrackedDevice(serial)
    if (!tracked) {
      // We don't know the platform yet; show pending startup immediately.
      return true
    }
    return isIosDevice(tracked)
  }

  function extractVideoPort(streamUrl) {
    if (!streamUrl) {
      return null
    }

    // Legacy path format: /frames/<providerIp>/<videoPort>/x
    var match = /\/(\d+)\/x(?:[/?#]|$)/.exec(streamUrl)
    if (match) {
      var fromFramesPath = parseInt(match[1], 10)
      return isNaN(fromFramesPath) ? null : fromFramesPath
    }

    // Direct stream format: ws://<providerIp>:<videoPort>/echo
    match = /^(?:wss?|https?):\/\/(?:\[[^\]]+\]|[^/:?#]+):(\d+)(?:[/?#]|$)/i.exec(streamUrl)
    if (!match) {
      return null
    }
    var fromHostPort = parseInt(match[1], 10)
    return isNaN(fromHostPort) ? null : fromHostPort
  }

  function isIosDevice(device) {
    if (!device) {
      return false
    }
    if (device.platformFamily === 'ios') {
      return true
    }
    return String(device.platform || '').toLowerCase() === 'ios'
  }

  function findStep(startup, id) {
    if (!startup || !startup.steps) {
      return null
    }
    for (var i = 0; i < startup.steps.length; i += 1) {
      if (startup.steps[i].id === id) {
        return startup.steps[i]
      }
    }
    return null
  }

  function updateStartupStep(startup, id, state, detail) {
    var step = findStep(startup, id)
    if (!step) {
      return
    }
    step.state = state
    step.detail = detail
  }

  function startupHasErrors(startup) {
    if (!startup || !startup.steps) {
      return false
    }
    for (var i = 0; i < startup.steps.length; i += 1) {
      if (startup.steps[i].state === 'error') {
        return true
      }
    }
    return false
  }

  function formatLocalTime(timestamp) {
    if (!timestamp) {
      return '-'
    }
    try {
      return new Date(timestamp).toLocaleTimeString()
    }
    catch (e) {
      return '-'
    }
  }

  function ensureStartupState(device) {
    var serial = device && device.serial || null
    if (!$scope.iosStartup || $scope.iosStartup.serial !== serial) {
      $scope.iosStartup = createIosStartupState(serial)
    }
    return $scope.iosStartup
  }

  function refreshIosStartup() {
    var device = $scope.device
    var startup = ensureStartupState(device || {
      serial: selectedSerial
    })

    if (!device) {
      startup.active = shouldOptimisticallyShowIosStartup(startup.serial)
      startup.completed = false
      startup.hasError = false

      if (startup.active) {
        updateStartupStep(
          startup
        , 'selected'
        , startup.serial ? 'active' : 'pending'
        , startup.serial ? startup.serial : 'Waiting for selected device serial'
        )
        updateStartupStep(startup, 'ready', 'pending', 'Waiting for device object')
        updateStartupStep(startup, 'identity', 'pending', 'Waiting for iOS identity payload')
        updateStartupStep(startup, 'endpoint', 'pending', 'Waiting for stream URL')
        updateStartupStep(startup, 'websocket', 'pending', 'Waiting for websocket open')
        updateStartupStep(startup, 'frame', 'pending', 'Waiting for first frame bytes')
      }

      return
    }

    selectedSerial = device.serial || selectedSerial
    if (!isIosDevice(device)) {
      startup.active = false
      startup.completed = false
      startup.hasError = false
      return
    }

    startup.active = true
    var ios = device.ios || {}
    var display = device.display || {}
    startup.diagnostics.displayUrl = display.url || null
    if (!startup.diagnostics.socketUrl) {
      startup.diagnostics.socketUrl = startup.diagnostics.displayUrl
    }
    startup.diagnostics.videoPort = extractVideoPort(
      startup.diagnostics.socketUrl || display.url
    )

    updateStartupStep(
      startup
    , 'selected'
    , device.serial ? 'done' : 'pending'
    , device.serial ? device.serial : 'Waiting for iOS device context'
    )

    if (device.present && Number(device.status) === 3 && device.ready && device.channel) {
      updateStartupStep(startup, 'ready', 'done', 'STF reports device ready')
    }
    else if (!device.present) {
      updateStartupStep(startup, 'ready', 'pending', 'Waiting for device present event')
    }
    else if (Number(device.status) !== 3) {
      updateStartupStep(
        startup
      , 'ready'
      , 'active'
      , 'Waiting for ONLINE status (status=' + String(device.status || '?') + ')'
      )
    }
    else {
      updateStartupStep(startup, 'ready', 'active', 'Waiting for ready channel assignment')
    }

    if (ios.udid) {
      updateStartupStep(startup, 'identity', 'done', ios.udid)
    }
    else {
      updateStartupStep(startup, 'identity', 'active', 'Waiting for iOS identity payload')
    }

    if (display.url) {
      if (startup.diagnostics.videoPort > 0) {
        updateStartupStep(
          startup
        , 'endpoint'
        , 'done'
        , 'videoPort=' + startup.diagnostics.videoPort
        )
      }
      else if (startup.diagnostics.videoPort === 0) {
        updateStartupStep(
          startup
        , 'endpoint'
        , 'error'
        , 'videoPort=0 in stream URL'
        )
      }
      else {
        updateStartupStep(
          startup
        , 'endpoint'
        , 'active'
        , 'Stream URL does not expose a video port'
        )
      }
    }
    else {
      updateStartupStep(startup, 'endpoint', 'active', 'Waiting for stream URL')
    }

    if (startup.diagnostics.socketState === 'open') {
      updateStartupStep(
        startup
      , 'websocket'
      , 'done'
      , 'Opened at ' + formatLocalTime(startup.diagnostics.openedAt)
      )
    }
    else if (startup.diagnostics.socketState === 'error') {
      if (startup.diagnostics.reconnectAttempts > 0) {
        updateStartupStep(
          startup
        , 'websocket'
        , 'active'
        , 'Socket error; retrying (attempt ' + startup.diagnostics.reconnectAttempts + ')'
        )
      }
      else {
        updateStartupStep(startup, 'websocket', 'error', 'WebSocket error before stream start')
      }
    }
    else if (startup.diagnostics.socketState === 'closed') {
      if (startup.diagnostics.reconnectAttempts > 0) {
        updateStartupStep(
          startup
        , 'websocket'
        , 'active'
        , 'Closed (' + String(startup.diagnostics.closeCode || 'n/a') +
          '); retrying attempt ' + startup.diagnostics.reconnectAttempts
        )
      }
      else {
        updateStartupStep(
          startup
        , 'websocket'
        , 'error'
        , 'Closed (' + String(startup.diagnostics.closeCode || 'n/a') + ')'
        )
      }
    }
    else {
      if (startup.diagnostics.reconnectAttempts > 0) {
        updateStartupStep(
          startup
        , 'websocket'
        , 'active'
        , 'Reconnecting (attempt ' + startup.diagnostics.reconnectAttempts +
          (startup.diagnostics.reconnectDelayMs ? ', next in ' +
            Math.round(startup.diagnostics.reconnectDelayMs / 1000) + 's' : '') + ')'
        )
      }
      else {
        updateStartupStep(startup, 'websocket', 'active', 'Connecting websocket')
      }
    }

    if (startup.diagnostics.firstVisibleFrameAt) {
      updateStartupStep(
        startup
      , 'frame'
      , 'done'
      , 'First visible frame at ' + formatLocalTime(startup.diagnostics.firstVisibleFrameAt)
      )
    }
    else if (startup.diagnostics.firstFrameAt) {
      if (startup.diagnostics.lastErrorCode === 'IOS_WDA_UNAVAILABLE' ||
        startup.diagnostics.lastErrorCode === 'IOS_WDA_SCREENSHOT_FAILED' ||
        startup.diagnostics.lastErrorCode === 'IOS_SCREENSHOT_FAILED') {
        updateStartupStep(
          startup
        , 'frame'
        , 'error'
        , 'Frames are dark and screenshot fallback failed (' +
          startup.diagnostics.lastErrorCode +
          (startup.diagnostics.lastErrorStatus ? ' status=' +
            startup.diagnostics.lastErrorStatus : '') + ')'
        )
      }
      else {
        updateStartupStep(
          startup
        , 'frame'
        , 'active'
        , 'Frames arriving, but content appears dark/blank (dark=' +
          String(startup.diagnostics.darkFrameCount || 0) + ')'
        )
      }
    }
    else if (startup.diagnostics.socketState === 'open') {
      updateStartupStep(startup, 'frame', 'active', 'Waiting for first frame bytes')
    }
    else if (startup.diagnostics.socketState === 'error' ||
      startup.diagnostics.socketState === 'closed') {
      if (startup.diagnostics.reconnectAttempts > 0) {
        updateStartupStep(
          startup
        , 'frame'
        , 'active'
        , 'Waiting for stream recovery after reconnect attempt ' +
          startup.diagnostics.reconnectAttempts
        )
      }
      else {
        updateStartupStep(startup, 'frame', 'error', 'Socket closed/error before first frame')
      }
    }
    else {
      updateStartupStep(startup, 'frame', 'pending', 'Waiting for websocket open')
    }

    startup.completed = !!startup.diagnostics.firstVisibleFrameAt
    startup.hasError = startupHasErrors(startup)
  }

  $scope.isIosDevice = isIosDevice

  $scope.shouldShowIosStartupOverlay = function() {
    if (!$scope.iosStartup) {
      return false
    }
    return !!$scope.iosStartup.active
  }

  $scope.toggleIosStartupOverlay = function() {
    if (!$scope.iosStartup) {
      return
    }
    $scope.iosStartup.expanded = !$scope.iosStartup.expanded
  }

  $scope.stepIconClass = function(stepState) {
    switch (stepState) {
      case 'done':
        return 'fa-check-circle'
      case 'active':
        return 'fa-spinner fa-spin'
      case 'error':
        return 'fa-times-circle'
      default:
        return 'fa-circle-o'
    }
  }

  $scope.$on('stf:ios-screen-stream', function(event, payload) {
    if (!payload || !$scope.device || payload.serial !== $scope.device.serial ||
      !isIosDevice($scope.device)) {
      return
    }

    if (payload.type !== 'fallback_frame') {
      debugLog('info', 'received ios stream event', {
        serial: payload.serial
      , type: payload.type
      , socketState: payload.socketState
      , frameCount: payload.frameCount
      , reconnectAttempt: payload.reconnectAttempt
      })
    }

    var startup = ensureStartupState($scope.device)
    startup.active = true
    if (typeof payload.socketUrl !== 'undefined') {
      startup.diagnostics.socketUrl = payload.socketUrl
    }
    startup.diagnostics.socketState = payload.socketState
    startup.diagnostics.openedAt = payload.openedAt
    startup.diagnostics.closedAt = payload.closedAt
    startup.diagnostics.errorAt = payload.errorAt
    startup.diagnostics.closeCode = payload.closeCode
    startup.diagnostics.closeReason = payload.closeReason
    startup.diagnostics.firstFrameAt = payload.firstFrameAt
    startup.diagnostics.firstVisibleFrameAt = payload.firstVisibleFrameAt
    startup.diagnostics.lastFrameAt = payload.lastFrameAt
    startup.diagnostics.frameCount = payload.frameCount
    if (typeof payload.renderedFrameCount === 'number') {
      startup.diagnostics.renderedFrameCount = payload.renderedFrameCount
    }
    if (typeof payload.skippedFrameCount === 'number') {
      startup.diagnostics.skippedFrameCount = payload.skippedFrameCount
    }
    if (typeof payload.lastRenderedAt === 'number') {
      startup.diagnostics.lastRenderedAt = payload.lastRenderedAt
    }
    if (typeof payload.lastBlobSize === 'number') {
      startup.diagnostics.lastBlobSize = payload.lastBlobSize
    }
    if (typeof payload.lastAverageLuma === 'number') {
      startup.diagnostics.lastAverageLuma = payload.lastAverageLuma
    }
    if (typeof payload.darkFrameCount === 'number') {
      startup.diagnostics.darkFrameCount = payload.darkFrameCount
    }
    startup.diagnostics.lastEventType = payload.type
    startup.diagnostics.lastEventAt = payload.at
    if (typeof payload.reconnectAttempt === 'number') {
      startup.diagnostics.reconnectAttempts = payload.reconnectAttempt
    }
    if (typeof payload.reconnectDelayMs === 'number') {
      startup.diagnostics.reconnectDelayMs = payload.reconnectDelayMs
    }
    if (typeof payload.reconnectReason !== 'undefined') {
      startup.diagnostics.reconnectReason = payload.reconnectReason
    }
    if (payload.type === 'socket_open') {
      startup.diagnostics.lastErrorMessage = null
      startup.diagnostics.lastErrorCode = null
      startup.diagnostics.lastErrorStatus = null
      startup.diagnostics.reconnectAttempts = 0
      startup.diagnostics.reconnectDelayMs = null
      startup.diagnostics.reconnectReason = null
    }
    else if (payload.errorMessage || payload.message) {
      startup.diagnostics.lastErrorMessage = payload.errorMessage || payload.message
    }
    if (payload.code) {
      startup.diagnostics.lastErrorCode = payload.code
    }
    if (typeof payload.status === 'number') {
      startup.diagnostics.lastErrorStatus = payload.status
    }
    refreshIosStartup()
  })

  $scope.$watch(function() {
    if (!$scope.device) {
      return ''
    }

    var display = $scope.device.display || {}
    var ios = $scope.device.ios || {}
    return [
      $scope.device.serial || ''
    , $scope.device.platformFamily || ''
    , $scope.device.platform || ''
    , $scope.device.present ? '1' : '0'
    , String($scope.device.status || '')
    , $scope.device.ready ? '1' : '0'
    , $scope.device.channel || ''
    , ios.udid || ''
    , display.url || ''
    ].join('|')
  }, function(newValue, oldValue) {
    if (newValue !== oldValue) {
      debugLog('info', 'device snapshot changed', {
        serial: $scope.device && $scope.device.serial
      , platform: $scope.device && $scope.device.platform
      , platformFamily: $scope.device && $scope.device.platformFamily
      , present: $scope.device && $scope.device.present
      , status: $scope.device && $scope.device.status
      , ready: $scope.device && $scope.device.ready
      , using: $scope.device && $scope.device.using
      , channel: $scope.device && $scope.device.channel
      , displayUrl: $scope.device && $scope.device.display && $scope.device.display.url
      })
    }
    refreshIosStartup()
  })

  $scope.$watchCollection('groupDevices', function() {
    if (!$scope.device) {
      refreshIosStartup()
    }
  })

  $scope.iosStartup = createIosStartupState(selectedSerial)
  refreshIosStartup()

  $scope.$on('$locationChangeStart', function(event, next, current) {
    $scope.LogcatService = LogcatService
    $rootScope.LogcatService = LogcatService
  })

  $scope.kickDevice = function(device) {
    if (Object.keys(LogcatService.deviceEntries).includes(device.serial)) {
      LogcatService.deviceEntries[device.serial].allowClean = true
    }

    $scope.LogcatService = LogcatService
    $rootScope.LogcatService = LogcatService

    if (!device || !$scope.device) {
      alert('No device found')
      return
    }

    try {
      // If we're trying to kick current device
      if (device.serial === $scope.device.serial) {

        // If there is more than one device left
        if ($scope.groupDevices.length > 1) {

          // Control first free device first
          var firstFreeDevice = _.find($scope.groupDevices, function(dev) {
            return dev.serial !== $scope.device.serial
          })
          $scope.controlDevice(firstFreeDevice)

          // Then kick the old device
          GroupService.kick(device).then(function() {
            $scope.$digest()
          })
        } else {
          // Kick the device
          GroupService.kick(device).then(function() {
            $scope.$digest()
          })
          $location.path('/devices/')
        }
      } else {
        GroupService.kick(device).then(function() {
          $scope.$digest()
        })
      }
    } catch (e) {
      alert(e.message)
    }
  }

  $scope.controlDevice = function(device) {
    $location.path('/control/' + device.serial)
  }

  function isPortrait(val) {
    var value = val
    if (typeof value === 'undefined' && $scope.device) {
      value = $scope.device.display.rotation
    }
    return (value === 0 || value === 180)
  }

  function isLandscape(val) {
    var value = val
    if (typeof value === 'undefined' && $scope.device) {
      value = $scope.device.display.rotation
    }
    return (value === 90 || value === 270)
  }

  $scope.tryToRotate = function(rotation) {
    if (rotation === 'portrait') {
      $scope.control.rotate(0)
      $timeout(function() {
        if (isLandscape()) {
          $scope.currentRotation = 'landscape'
        }
      }, 400)
    } else if (rotation === 'landscape') {
      $scope.control.rotate(90)
      $timeout(function() {
        if (isPortrait()) {
          $scope.currentRotation = 'portrait'
        }
      }, 400)
    }
  }

  $scope.currentRotation = 'portrait'

  $scope.$watch('device.display.rotation', function(newValue) {
    if (isPortrait(newValue)) {
      $scope.currentRotation = 'portrait'
    } else if (isLandscape(newValue)) {
      $scope.currentRotation = 'landscape'
    }
  })

  // TODO: Refactor this inside control and server-side
  $scope.rotateLeft = function() {
    var angle = 0
    if ($scope.device && $scope.device.display) {
      angle = $scope.device.display.rotation
    }
    if (angle === 0) {
      angle = 270
    } else {
      angle -= 90
    }
    $scope.control.rotate(angle)

    if ($rootScope.standalone) {
      $window.resizeTo($window.outerHeight, $window.outerWidth)
    }
  }

  $scope.rotateRight = function() {
    var angle = 0
    if ($scope.device && $scope.device.display) {
      angle = $scope.device.display.rotation
    }
    if (angle === 270) {
      angle = 0
    } else {
      angle += 90
    }
    $scope.control.rotate(angle)

    if ($rootScope.standalone) {
      $window.resizeTo($window.outerHeight, $window.outerWidth)
    }
  }

}
