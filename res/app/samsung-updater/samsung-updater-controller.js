module.exports = function SamsungUpdaterCtrl(
  $scope
, $q
, $interval
, $filter
, gettext
, $window
, DeviceService
, StorageService
) {
  var REFRESH_INTERVAL_MS = 2000
  var PACKAGE_REF_HISTORY_KEY = 'stf.samsungUpdater.packageRefHistory'
  var PACKAGE_REF_HISTORY_LIMIT = 15
  var MODAL_CLOSE_GUARD_MS = 250
  var modalCloseGuardUntil = 0

  $scope.tracker = DeviceService.trackAll($scope)
  $scope.loading = false
  $scope.error = null
  $scope.serviceStatus = null
  $scope.jobs = []
  $scope.selectedJobId = null
  $scope.selectedJob = null
  $scope.selectedJobError = null
  $scope.loadingSelectedJob = false
  $scope.lastRefreshedAt = null
  $scope.queueing = false
  $scope.uploadingPackage = false
  $scope.packageUploadProgress = 0
  $scope.packageUploadError = null
  $scope.packageUploadLastHref = null
  $scope.canceling = {}
  $scope.packageRefHistory = []
  $scope.selectedPackageRefHistory = ''
  $scope.form = {
      serial: ''
    , executionMode: 'dry-run'
    , packageRef: 'firmware://sm-t830/xar/u5'
    , manifestPath: '/workspace/tmp/phase2_manifest.json'
    , simulate: true
    , destructiveConfirmation: ''
    , message: 'Flash job queued from Samsung Updater page'
    }

  function normalizePackageRef(value) {
    if (typeof value !== 'string') {
      return null
    }
    var normalized = value.trim()
    return normalized.length ? normalized : null
  }

  function buildPackageRefHistory(values) {
    var seen = Object.create(null)
    var output = []

    ;(values || []).forEach(function(value) {
      var normalized = normalizePackageRef(value)
      if (!normalized || seen[normalized]) {
        return
      }
      seen[normalized] = true
      output.push(normalized)
    })

    return output.slice(0, PACKAGE_REF_HISTORY_LIMIT)
  }

  function loadPackageRefHistory() {
    try {
      if (!$window.localStorage) {
        return []
      }
      var raw = $window.localStorage.getItem(PACKAGE_REF_HISTORY_KEY)
      if (!raw) {
        return []
      }
      var parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        return []
      }
      return buildPackageRefHistory(parsed)
    }
    catch (err) {
      return []
    }
  }

  function persistPackageRefHistory(items) {
    try {
      if (!$window.localStorage) {
        return
      }
      $window.localStorage.setItem(
        PACKAGE_REF_HISTORY_KEY,
        JSON.stringify(buildPackageRefHistory(items))
      )
    }
    catch (err) {
      return
    }
  }

  function rememberPackageRef(value) {
    var normalized = normalizePackageRef(value)
    if (!normalized) {
      return
    }

    $scope.packageRefHistory = buildPackageRefHistory(
      [normalized].concat($scope.packageRefHistory || [])
    )
    persistPackageRefHistory($scope.packageRefHistory)
  }

  function extractUploadedResource(response) {
    var resources = response &&
      response.data &&
      response.data.resources &&
      typeof response.data.resources === 'object' ?
      response.data.resources :
      null

    if (!resources) {
      return null
    }

    if (resources.file && resources.file.href) {
      return resources.file
    }

    var keys = Object.keys(resources)
    if (!keys.length) {
      return null
    }

    var first = resources[keys[0]]
    return first && first.href ? first : null
  }

  function errorDetail(err) {
    return err && err.data && err.data.description ?
      err.data.description :
      (err && err.message ? err.message : String(err))
  }

  function toDateString(value) {
    if (!value) {
      return 'n/a'
    }
    var date = new Date(value)
    if (isNaN(date.getTime())) {
      return 'n/a'
    }
    return date.toLocaleString()
  }

  function normalizeLogEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
          line: entry ? String(entry) : ''
        , at: null
        , level: 'info'
        , eventType: 'legacy'
        }
    }
    return entry
  }

  function sortedTargetDevices() {
    return ($scope.tracker.devices || [])
      .filter(function(device) {
        return device &&
          device.serial &&
          device.kind !== 'service' &&
          device.present !== false
      })
      .map(function(device) {
        return {
            serial: device.serial
          , label: (device.enhancedName || device.name || device.model || device.serial) +
              ' (' + device.serial + ')'
          }
      })
      .sort(function(a, b) {
        return a.label.localeCompare(b.label)
      })
  }

  function ensureSelectedSerial() {
    var devices = sortedTargetDevices()
    var hasSelected = devices.some(function(item) {
      return item.serial === $scope.form.serial
    })
    if (!hasSelected) {
      $scope.form.serial = devices.length ? devices[0].serial : ''
    }
    return devices
  }

  function syncSelectedJobFromList() {
    if (!$scope.selectedJobId) {
      return
    }

    var match = null
    for (var i = 0; i < $scope.jobs.length; ++i) {
      if ($scope.jobs[i] && $scope.jobs[i].id === $scope.selectedJobId) {
        match = $scope.jobs[i]
        break
      }
    }

    if (match) {
      $scope.selectedJob = Object.assign({}, $scope.selectedJob || {}, match)
    }
  }

  function refreshServiceStatus() {
    return DeviceService.getSamsungFlashServiceStatus()
      .then(function(status) {
        $scope.serviceStatus = status || null
      })
  }

  function refreshJobs() {
    return DeviceService.listSamsungFlashJobs({
      limit: 50
    , includeLogs: false
    })
      .then(function(jobs) {
        $scope.jobs = jobs || []
        syncSelectedJobFromList()
      })
  }

  function refreshSelectedJob() {
    if (!$scope.selectedJobId) {
      $scope.selectedJob = null
      $scope.selectedJobError = null
      return $q.when(null)
    }

    $scope.loadingSelectedJob = true
    return DeviceService.getSamsungFlashJob($scope.selectedJobId)
      .then(function(job) {
        if (!job) {
          $scope.selectedJob = null
          $scope.selectedJobError = 'Selected job no longer exists'
          return null
        }
        $scope.selectedJob = job
        $scope.selectedJobError = null
        return job
      })
      .catch(function(err) {
        $scope.selectedJobError = errorDetail(err)
        return null
      })
      .finally(function() {
        $scope.loadingSelectedJob = false
      })
  }

  function refreshAll() {
    $scope.loading = true
    $scope.error = null

    return $q.all([
      refreshServiceStatus(),
      refreshJobs()
    ])
      .then(function() {
        return refreshSelectedJob()
      })
      .then(function() {
        $scope.lastRefreshedAt = new Date()
      })
      .catch(function(err) {
        $scope.error = errorDetail(err)
      })
      .finally(function() {
        $scope.loading = false
      })
  }

  $scope.targetDevices = function() {
    return ensureSelectedSerial()
  }

  $scope.requiresConfirmation = function() {
    return $scope.form.executionMode === 'execute'
  }

  $scope.canQueue = function() {
    if (!$scope.form.serial || !$scope.form.serial.trim()) {
      return false
    }
    if (!$scope.form.packageRef || !$scope.form.packageRef.trim()) {
      return false
    }
    if (!$scope.form.manifestPath || !$scope.form.manifestPath.trim()) {
      return false
    }
    if (
      $scope.requiresConfirmation() &&
      (!$scope.form.destructiveConfirmation || !$scope.form.destructiveConfirmation.trim())
    ) {
      return false
    }
    return true
  }

  $scope.refresh = function() {
    refreshAll()
  }

  $scope.formatDate = function(value) {
    return toDateString(value)
  }

  $scope.applySelectedPackageRef = function() {
    var normalized = normalizePackageRef($scope.selectedPackageRefHistory)
    if (!normalized) {
      return
    }
    $scope.form.packageRef = normalized
  }

  $scope.uploadPackageFile = function($files) {
    if (!$files || !$files.length || $scope.uploadingPackage) {
      return
    }

    $scope.uploadingPackage = true
    $scope.packageUploadProgress = 0
    $scope.packageUploadError = null
    $scope.packageUploadLastHref = null

    StorageService.storeFile('samsung-firmware', $files, {
      filter: function(file) {
        return !!file
      }
    })
      .progressed(function(event) {
        if (event && event.lengthComputable && event.total > 0) {
          $scope.packageUploadProgress = Math.floor((event.loaded / event.total) * 100)
        }
      })
      .then(function(response) {
        var resource = extractUploadedResource(response)
        if (!resource || !resource.href) {
          throw new Error('Upload succeeded but no storage resource href returned')
        }

        $scope.packageUploadProgress = 100
        $scope.packageUploadLastHref = resource.href
        $scope.form.packageRef = resource.href
        rememberPackageRef(resource.href)
        $scope.selectedPackageRefHistory = ''
      })
      .catch(function(err) {
        $scope.packageUploadError = errorDetail(err)
      })
      .finally(function() {
        $scope.uploadingPackage = false
      })
  }

  $scope.selectJob = function(job, $event) {
    if ($event) {
      $event.stopPropagation()
    }
    if (!job || !job.id) {
      return
    }

    $scope.selectedJobId = job.id
    $scope.selectedJob = Object.assign({}, job)
    $scope.selectedJobError = null
    refreshSelectedJob()
  }

  $scope.toggleJobPopover = function(job, $event) {
    if ($event) {
      $event.preventDefault()
      $event.stopPropagation()
    }
    if (Date.now() < modalCloseGuardUntil) {
      return
    }
    if (!job || !job.id) {
      return
    }

    if ($scope.selectedJobId === job.id) {
      $scope.clearSelection()
      return
    }

    $scope.selectJob(job)
  }

  $scope.closeJobModal = function($event) {
    if ($event) {
      $event.preventDefault()
      $event.stopPropagation()
    }
    modalCloseGuardUntil = Date.now() + MODAL_CLOSE_GUARD_MS
    $scope.selectedJobId = null
    $scope.selectedJob = null
    $scope.selectedJobError = null
  }

  $scope.clearSelection = function($event) {
    $scope.closeJobModal($event)
  }

  $scope.isSelectedJob = function(job) {
    return !!job && !!job.id && job.id === $scope.selectedJobId
  }

  $scope.refreshSelectedJob = function($event) {
    if ($event) {
      $event.stopPropagation()
    }
    refreshSelectedJob()
  }

  $scope.selectedLogs = function() {
    if (!$scope.selectedJob || !Array.isArray($scope.selectedJob.logLines)) {
      return []
    }
    return $scope.selectedJob.logLines
  }

  $scope.formatLogEntry = function(entry) {
    var logEntry = normalizeLogEntry(entry)
    var tokens = []

    if (logEntry.at) {
      tokens.push('[' + toDateString(logEntry.at) + ']')
    }
    if (logEntry.level) {
      tokens.push('[' + String(logEntry.level).toUpperCase() + ']')
    }
    if (logEntry.step) {
      tokens.push('[step=' + logEntry.step + ']')
    }
    if (logEntry.eventType) {
      tokens.push('[type=' + logEntry.eventType + ']')
    }
    if (logEntry.stream) {
      tokens.push('[stream=' + logEntry.stream + ']')
    }
    if (logEntry.commandId) {
      tokens.push('[cmd=' + logEntry.commandId + ']')
    }
    if (logEntry.command) {
      tokens.push(logEntry.command + (
        Array.isArray(logEntry.args) && logEntry.args.length ? ' ' + logEntry.args.join(' ') : ''
      ))
    }
    if (typeof logEntry.pid === 'number') {
      tokens.push('[pid=' + logEntry.pid + ']')
    }
    if (logEntry.phase) {
      tokens.push('[phase=' + logEntry.phase + ']')
    }
    if (typeof logEntry.code === 'number') {
      tokens.push('[exit=' + logEntry.code + ']')
    }
    if (logEntry.signal) {
      tokens.push('[signal=' + logEntry.signal + ']')
    }
    if (typeof logEntry.durationMs === 'number') {
      tokens.push('[durationMs=' + logEntry.durationMs + ']')
    }
    if (logEntry.partition) {
      tokens.push('[partition=' + logEntry.partition + ']')
    }
    if (logEntry.artifactId) {
      tokens.push('[artifact=' + logEntry.artifactId + ']')
    }
    if (logEntry.actionType) {
      tokens.push('[action=' + logEntry.actionType + ']')
    }
    if (logEntry.line) {
      tokens.push(logEntry.line)
    }

    return tokens.join(' ')
  }

  $scope.queueJob = function() {
    if (!$scope.canQueue() || $scope.queueing) {
      return
    }

    var payload = {
        serial: $scope.form.serial.trim()
      , executionMode: $scope.form.executionMode === 'execute' ? 'execute' : 'dry-run'
      , executionBackend: 'mac-dev-local'
      , packageRef: $scope.form.packageRef.trim()
      , manifestPath: $scope.form.manifestPath.trim()
      , simulate: $scope.form.simulate === true
      , message: $scope.form.message ? $scope.form.message.trim() : undefined
      }

    if ($scope.requiresConfirmation()) {
      payload.destructiveConfirmation = $scope.form.destructiveConfirmation.trim()
    }

    $scope.queueing = true
    DeviceService.createSamsungFlashJob(payload)
      .then(function(job) {
        var message = $filter('translate')(gettext('Samsung Updater job queued.'))
        if (job && job.id) {
          message += '\n' + $filter('translate')(gettext('Job ID')) + ': ' + job.id
        }
        $window.alert(message)
        $scope.form.destructiveConfirmation = ''
        rememberPackageRef(payload.packageRef)
        $scope.selectedPackageRefHistory = ''
        return refreshAll()
      })
      .catch(function(err) {
        var detail = errorDetail(err)
        $window.alert($filter('translate')(gettext('Failed to queue Samsung Updater job.')) + '\n' + detail)
      })
      .finally(function() {
        $scope.queueing = false
      })
  }

  $scope.cancelJob = function(job, $event) {
    if ($event) {
      $event.stopPropagation()
    }
    if (!job || !job.id || $scope.canceling[job.id]) {
      return
    }

    var confirmText =
      $filter('translate')(gettext('Cancel this Samsung Updater job?')) + '\n' +
      (job.id || '')
    if (!$window.confirm(confirmText)) {
      return
    }

    $scope.canceling[job.id] = true
    DeviceService.cancelSamsungFlashJob(job.id, 'Canceled from Samsung Updater page')
      .then(function() {
        return refreshAll()
      })
      .catch(function(err) {
        var detail = errorDetail(err)
        $window.alert($filter('translate')(gettext('Failed to cancel Samsung Updater job.')) + '\n' + detail)
      })
      .finally(function() {
        delete $scope.canceling[job.id]
      })
  }

  $scope.isCancellable = function(job) {
    return !!job && [
      'queued',
      'validating',
      'preparing',
      'entering_download_mode',
      'flashing',
      'verifying',
      'reboot_wait'
    ].indexOf(job.status) !== -1
  }

  ensureSelectedSerial()
  $scope.packageRefHistory = loadPackageRefHistory()
  refreshAll()

  var poller = $interval(function() {
    ensureSelectedSerial()
    refreshAll()
  }, REFRESH_INTERVAL_MS)

  $scope.$on('$destroy', function() {
    $interval.cancel(poller)
  })
}
