#!/usr/bin/env bash
# Opens a large PDF in Folio on an Android emulator the way a user does (another
# app sends it with "Open with"), then records Folio's memory, screenshots and log.
# Usage: LARGE_PDF_URL=... scripts/tests/android-large-pdf.sh release/android/<apk>
set -euo pipefail
apk=$1
out=test-results/android-large
mkdir -p "$out"
adb install -r "$apk"
curl -sSL --retry 4 -o "$RUNNER_TEMP/Large.pdf" "$LARGE_PDF_URL"
bytes=$(stat -c %s "$RUNNER_TEMP/Large.pdf")
adb push "$RUNNER_TEMP/Large.pdf" /sdcard/Download/Large.pdf > /dev/null
adb shell content call --uri content://media/ --method scan_volume --arg external_primary > /dev/null || true
id=""
for _ in $(seq 1 30); do
  id=$(adb shell content query --uri content://media/external/file --projection _id --where "_display_name=\'Large.pdf\'" | sed -n 's/.*_id=\([0-9]*\).*/\1/p' | head -1)
  [ -n "$id" ] && break
  sleep 2
done
[ -n "$id" ] || { echo "MediaStore did not index the PDF"; exit 1; }
adb logcat -c
adb shell am start -W -a android.intent.action.VIEW -t application/pdf -d "content://media/external/file/$id" \
  --grant-read-uri-permission -n org.folio.pdf/.MainActivity | tee "$out/start.txt"
peak=0; alive=true
echo '{"bytes":'"$bytes"',"samples":[' > "$out/samples.json"
for second in $(seq 0 5 180); do
  pid=$(adb shell pidof org.folio.pdf | tr -d '\r' || true)
  if [ -z "$pid" ]; then alive=false; echo "{\"s\":$second,\"alive\":false}" >> "$out/samples.json"; break; fi
  # Total PSS of Folio's process, which holds the WebView renderer's IPC and the native reader.
  kb=$(adb shell dumpsys meminfo org.folio.pdf | awk '/TOTAL PSS:/ {print $3; exit} /^ *TOTAL / {print $2; exit}' | tr -d '\r')
  kb=${kb:-0}; [ "$kb" -gt "$peak" ] && peak=$kb
  echo "{\"s\":$second,\"alive\":true,\"pssKB\":$kb}," >> "$out/samples.json"
  [ $((second % 30)) -eq 0 ] && adb exec-out screencap -p > "$out/screen-$second.png"
  sleep 5
done
echo '{}],"alive":'"$alive"',"peakPssKB":'"$peak"'}' >> "$out/samples.json"
adb logcat -d > "$out/logcat.txt" || true
grep -iE "folio|AndroidRuntime|FATAL|lowmemorykiller|chromium" "$out/logcat.txt" | tail -200 > "$out/logcat-folio.txt" || true
# Kill Folio within 15 s of opening the PDF again (while its marker is on disk): the next
# launch must say so and not reopen it.
adb shell am force-stop org.folio.pdf
adb shell am start -W -a android.intent.action.VIEW -t application/pdf -d "content://media/external/file/$id" \
  --grant-read-uri-permission -n org.folio.pdf/.MainActivity > /dev/null
sleep 10
adb shell am force-stop org.folio.pdf
adb shell am start -W -n org.folio.pdf/.MainActivity > /dev/null
sleep 12
adb exec-out screencap -p > "$out/after-interrupted-open.png"
echo "alive=$alive peakPss=${peak}KB bytes=$bytes"
[ "$alive" = true ]
