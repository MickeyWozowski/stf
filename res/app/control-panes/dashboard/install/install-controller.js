module.exports = function InstallCtrl(
  $scope
, InstallService
, AppState
) {
  $scope.accordionOpen = true
  $scope.installation = null
  $scope.launchBundleId = ''
  $scope.launchAppStatus = null

  $scope.clear = function() {
    $scope.installation = null
    $scope.accordionOpen = false
    $scope.launchAppStatus = null
  }

  $scope.$on('installation', function(e, installation) {
    $scope.installation = installation.apply($scope)
  })

  $scope.installUrl = function(url) {
    return InstallService.installUrl($scope.control, url)
  }

  $scope.installFile = function($files) {
    if ($files.length) {
      return InstallService.installFile($scope.control, $files)
    }
  }

  $scope.uninstall = function(packageName) {
    // TODO: After clicking uninstall accordion opens
    return $scope.control.uninstall(packageName)
      .then(function() {
        $scope.$apply(function() {
          $scope.clear()
        })
      })
  }

  $scope.isIOS = function() {
    return AppState.device && AppState.device.platform === 'iOS'
  }

  $scope.launchApp = function(bundleId) {
    if (!bundleId) {
      return
    }
    $scope.launchAppStatus = {
      success: null
    , text: 'Launching app...'
    }

    return $scope.control.launchApp(bundleId)
      .then(function(result) {
        $scope.$apply(function() {
          $scope.launchAppStatus = {
            success: !!(result && result.success)
          , text: result && result.success ? 'App launched' : 'Launch failed'
          }
        })
      })
      .catch(function() {
        $scope.$apply(function() {
          $scope.launchAppStatus = {
            success: false
          , text: 'Launch failed'
          }
        })
      })
  }
}
