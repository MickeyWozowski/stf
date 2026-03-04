## TO DO List
- Make the home button work on control page


## Adding a New iPhone to the System (Current Process)
1. Prepare host prerequisites (macOS provider machine)
   - Xcode installed and selected (`xcode-select -p`).
   - iPhone Developer Mode enabled.
   - `ios-deploy` available (`ios-deploy --version`).
   - STF iOS support repo exists at:
     - `/Users/naokiogishi/Projects/STF iOS/stf_ios_support`

2. Physically connect and trust the device
   - Connect the iPhone by USB.
   - Unlock the phone.
   - Accept "Trust This Computer" on device if prompted.

3. Confirm device visibility on host
   - Run: `ios-deploy -c -t 1`
   - Expected: UDID appears in output.
   - If not visible: replug cable, unlock again, re-trust, retry.

4. Start STF + coordinator stack
   - From STF repo root:
     - `cd /Users/naokiogishi/Projects/STF/stf`
     - `./restart-all.sh`
   - Expected startup artifacts:
     - `tmp/restart-all/stf-local.log`
     - `tmp/restart-all/ios-coordinator.log`

5. Verify iOS lifecycle events
   - In STF log, confirm iOS provider subscription/introduction:
     - `Subscribed device channel ...`
     - `Introduced iOS device "<UDID>"`
   - In coordinator log, confirm:
     - `Device connected`
     - `WDA Running` (for touch/home/type controls)
     - `Fetched WDA session` and dimensions.

6. Verify device appears in STF UI
   - Open URL printed by `restart-all.sh` (same host/IP it reports).
   - Check iPhone is listed as online.
   - Open control view and verify screen stream loads.

7. Sanity check controls/actions
   - Home button in control page.
   - Tap interaction on screen.
   - App install/launch path (if `.ipa` available).
   - Screenshot capture.

8. If add flow fails, collect and check logs first
   - `tail -f tmp/restart-all/stf-local.log tmp/restart-all/ios-coordinator.log`
   - Common blockers:
     - No `WDA Running` => WDA/toolchain issue on host.
     - Device not in `ios-deploy -c` => USB trust/detection issue.
     - Screen only/no control => WDA session/dimension mismatch in control path.
