module.exports = angular.module('stf/device', [
  require('./device-info-filter').name,
  require('./enhance-device').name,
  require('stf/socket').name,
  require('stf/transaction').name
])
  .factory('DeviceService', require('./device-service'))
  .factory('StateClassesService', require('./state-classes-service'))
