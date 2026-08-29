#!/bin/bash
# Bidirectional compatibility live test orchestrator.
# The sandbox kills background processes between tool calls, so servers and
# both test phases must run inside this single invocation.
set -u
cd /home/z/my-project/repos/openlist-bin

echo "== starting OpenList (fresh data dir) =="
rm -rf /tmp/openlist-data
pkill -f "openlist server" 2>/dev/null
pkill -f "vite --port 3000" 2>/dev/null
sleep 1
setsid nohup env OPENLIST_ADMIN_PASSWORD=admin ./openlist server --data /tmp/openlist-data --log-std > /tmp/openlist.log 2>&1 < /dev/null &
for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:5244/api/public/settings > /dev/null && break
  sleep 1
done
curl -sf -o /dev/null http://127.0.0.1:5244/api/public/settings && echo "OpenList UP" || { echo "OpenList FAILED"; tail -20 /tmp/openlist.log; exit 1; }

echo "== starting NextList =="
cd /home/z/my-project/repos/NextList
setsid nohup npx vite --port 3000 --host 0.0.0.0 > /tmp/nextlist.log 2>&1 < /dev/null &
for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:3000/api/health > /dev/null && break
  sleep 1
done
curl -sf -o /dev/null http://127.0.0.1:3000/api/health && echo "NextList UP" || { echo "NextList FAILED"; tail -20 /tmp/nextlist.log; exit 1; }

echo; echo "################ RUN PHASE 1 ################"
node scripts/test-bidirectional-compat.mjs phase1
P1=$?

echo; echo "== restarting NextList (fresh in-memory DB) =="
pkill -f "vite --port 3000" 2>/dev/null
sleep 2
setsid nohup npx vite --port 3000 --host 0.0.0.0 > /tmp/nextlist2.log 2>&1 < /dev/null &
for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:3000/api/health > /dev/null && break
  sleep 1
done
curl -sf -o /dev/null http://127.0.0.1:3000/api/health && echo "NextList UP (fresh)" || { echo "NextList RESTART FAILED"; tail -20 /tmp/nextlist2.log; exit 1; }

echo; echo "################ RUN PHASE 2 ################"
node scripts/test-bidirectional-compat.mjs phase2
P2=$?

echo; echo "################ SUMMARY ################"
echo "phase1 exit=$P1, phase2 exit=$P2"
if [ "$P1" -eq 0 ] && [ "$P2" -eq 0 ]; then
  echo "ALL COMPATIBILITY TESTS PASSED"
else
  echo "SOME TESTS FAILED"
fi
exit $((P1 + P2))
