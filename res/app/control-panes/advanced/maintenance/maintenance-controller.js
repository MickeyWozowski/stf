module.exports = function($scope, gettext, $filter, $window) {

  $scope.reboot = function() {
    var config = {
      rebootEnabled: true
    }

    /* eslint no-console: 0 */
    if (config.rebootEnabled) {
      var line1 = $filter('translate')(gettext('Are you sure you want to reboot this device?'))
      var line2 = $filter('translate')(gettext('The device will be unavailable for a moment.'))
      if (confirm(line1 + '\n' + line2)) {
        $scope.control.reboot().then(function(result) {
          console.error(result)
        })
      }
    }
  }

  function promptValue(message, defaultValue) {
    return $window.prompt(message, defaultValue)
  }

  function promptBool(message, defaultValue) {
    var value = promptValue(message, defaultValue ? 'yes' : 'no')
    if (value === null) {
      return null
    }
    value = String(value).trim().toLowerCase()
    return ['y', 'yes', 'true', '1'].indexOf(value) !== -1
  }

  $scope.launchSamsungEngineering = function() {
    var serial = $scope.device && $scope.device.serial
    if (!serial) {
      $window.alert($filter('translate')(gettext('Device serial is unavailable.')))
      return
    }

    var line1 = $filter('translate')(gettext('Queue a Samsung Updater job from the engineering menu?'))
    var line2 = $filter('translate')(gettext('This is a development workflow and can be destructive in execute mode.'))
    if (!$window.confirm(line1 + '\n' + line2)) {
      return
    }

    var executionMode = promptValue(
      $filter('translate')(gettext('Execution mode (dry-run or execute)'))
    , 'dry-run')

    if (executionMode === null) {
      return
    }

    executionMode = executionMode.trim().toLowerCase()
    if (['dry-run', 'execute'].indexOf(executionMode) === -1) {
      $window.alert($filter('translate')(gettext('Invalid execution mode. Use dry-run or execute.')))
      return
    }

    var packageRef = promptValue(
      $filter('translate')(gettext('Package reference'))
    , 'firmware://sm-t830/xar/u5')

    if (packageRef === null || !packageRef.trim()) {
      return
    }

    var manifestPath = promptValue(
      $filter('translate')(gettext('Manifest path'))
    , '/workspace/tmp/phase2_manifest.json')

    if (manifestPath === null || !manifestPath.trim()) {
      return
    }

    var csc = promptValue(
      $filter('translate')(gettext('Device CSC'))
    , 'XAR')

    if (csc === null || !csc.trim()) {
      return
    }

    var bootloader = promptValue(
      $filter('translate')(gettext('Device bootloader'))
    , 'T830XXU5CVG2')

    if (bootloader === null || !bootloader.trim()) {
      return
    }

    var simulate = promptBool(
      $filter('translate')(gettext('Simulate execution only? (yes/no)'))
    , true)

    if (simulate === null) {
      return
    }

    var destructiveConfirmation = null
    if (executionMode === 'execute') {
      destructiveConfirmation = promptValue(
        $filter('translate')(gettext('Type confirmation phrase'))
      , 'I_UNDERSTAND_THIS_WILL_FLASH')

      if (destructiveConfirmation === null || !destructiveConfirmation.trim()) {
        return
      }
    }

    var payload = {
        serial: serial
      , packageRef: packageRef.trim()
      , executionMode: executionMode
      , executionBackend: 'mac-dev-local'
      , manifestPath: manifestPath.trim()
      , simulate: simulate
      , deviceInfo: {
          csc: csc.trim().toUpperCase()
        , bootloader: bootloader.trim()
        }
      }

    if (destructiveConfirmation) {
      payload.destructiveConfirmation = destructiveConfirmation.trim()
    }

    $scope.control.enqueueSamsungFlash(payload)
      .then(function(result) {
        if (!result.success) {
          $window.alert(
            $filter('translate')(gettext('Failed to queue Samsung Updater job.')) + '\n' +
            JSON.stringify(result.lastData || result.error || {}, null, 2)
          )
          return
        }

        var message = $filter('translate')(gettext('Samsung Updater job queued.'))
        if (result.lastData && result.lastData.jobId) {
          message += '\n' + $filter('translate')(gettext('Job ID')) + ': ' + result.lastData.jobId
        }
        $window.alert(message)
      })
      .catch(function(err) {
        var errorMessage = err && err.message ? err.message : String(err)
        if (typeof errorMessage === 'object') {
          errorMessage = JSON.stringify(errorMessage, null, 2)
        }
        $window.alert(
          $filter('translate')(gettext('Failed to queue Samsung Updater job.')) + '\n' +
          errorMessage
        )
      })
  }

}
