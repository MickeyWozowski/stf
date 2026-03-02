require('./samsung-updater.css')

module.exports = angular.module('samsung-updater', [
  require('stf/device').name
, require('stf/storage').name
])
  .config(['$routeProvider', function($routeProvider) {
    $routeProvider
      .when('/services/samsung-updater', {
        template: require('./samsung-updater.pug'),
        controller: 'SamsungUpdaterCtrl'
      })
  }])
  .controller('SamsungUpdaterCtrl', require('./samsung-updater-controller'))
