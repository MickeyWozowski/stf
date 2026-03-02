Model: SM-T830
Device: gts4lwifi / gts4lwifixx
CSC: XAR (USA)
Bootloader/PDA: T830XXU5CVG2
Android: 10
Security patch: 2022-06-01

---

# Galaxy Tab S4 (SM-T830) Reflash Runbook: "Base Android" (AOSP GSI)

## 1) What to flash for this exact device

- Device facts from ADB:
  - Treble: `true`
  - ABI: `arm64-v8a`
  - A/B slots: not present (A-only style layout)
  - Vendor API level: 29 (Android 10)
- Safest target for compatibility is an Android 10 arm64 GSI (API 29), not a newest Android preview build.

Use Google GSI release index to select:
- `aosp_arm64` (arm64, non-A/B style target for this device class)
- Android 10 (API 29) branch

Reference:
- https://developer.android.com/topic/generic-system-image/releases

## 2) Preconditions (do these first)

- Keep a rollback package ready for this tablet:
  - Stock Samsung firmware matching model/CSC/bootloader family:
    - `SM-T830 / XAR / T830XXU5CVG2` (or same bootloader major `U5`)
- Ensure battery >= 60%.
- Confirm bootloader is unlocked and USB debugging works.
- Back up user data and (if available) EFS/persist-related partitions.

## 3) Flash method for Tab S4

Important:
- Samsung Tab S4 does not use the standard Pixel/Nexus fastboot flashing flow.
- Use your established Samsung recovery flow (custom recovery/Odin workflow).

High-level sequence:
1. Download and extract the selected GSI zip; obtain `system.img` (or `system.img` from sparse image extraction if needed).
2. Boot device into custom recovery environment that can flash partition images.
3. Optional but recommended: full partition backup (at least `boot`, `system`, `vendor`, `efs`).
4. Wipe `system` (do not blindly wipe vendor/modem partitions).
5. Flash GSI `system.img` to `system` partition.
6. Apply required verity/encryption-disabler steps for your recovery workflow if boot loops occur.
7. Reboot and wait for first boot (can take several minutes).
8. Verify:
   - `adb shell getprop ro.build.fingerprint`
   - UI boots, touch/Wi-Fi/display/sensors work.

If it fails to boot:
- Restore stock firmware package for `SM-T830 XAR` via Samsung recovery tooling path.

## 4) Why this is different from QDL flashing

Comparison by aspect:

- Primary goal:
  - AOSP GSI path (this runbook): Boot a generic base Android userspace for testing.
  - QDL flashing plan (`doc/QDL_FLASHING_PLAN.md`): Full low-level firmware flashing workflow in STF.

- Transport/protocol:
  - AOSP GSI path: Recovery-based partition image flash.
  - QDL flashing plan: EDL/Sahara/Firehose (`qdl`) on provider host.

- Typical partitions touched:
  - AOSP GSI path: Mainly `system` (+ optional boot/verity adjustments).
  - QDL flashing plan: Multiple rawprogram-defined partitions.

- Device model coupling:
  - AOSP GSI path: Generic image + Treble compatibility.
  - QDL flashing plan: Strongly device-specific package/manifest/programmer.

- STF integration level:
  - AOSP GSI path: Manual operator workflow today.
  - QDL flashing plan: Planned first-class STF job orchestration (API/UI/logs/audit).

- Brick risk:
  - AOSP GSI path: Moderate.
  - QDL flashing plan: Higher if wrong firehose/rawprogram/partition map.

- Best use case:
  - AOSP GSI path: Quick "base Android" bring-up/validation.
  - QDL flashing plan: Production-like refurbish/recovery/reprovision flows.

## 5) Recommendation for this project

- For immediate "base Android" testing on this Tab S4, use the GSI path above.
- Keep QDL work as a separate STF feature track per `doc/QDL_FLASHING_PLAN.md`, because it is a different operational class (fleet-grade, auditable, higher-risk flashing).
