#!/bin/bash
# Storage status/health-check E2E test orchestrator.
# The sandbox kills background processes between tool calls, so the server
# and the test must run inside this single invocation.
set -u
cd /home/z/my-project/repos/NextList

pkill -f "vite --port 3000" 2>/dev/null
sleep 1

echo "== starting NextList =="
setsid nohup npx vite --port 3000 --host 0.0.0.0 > /tmp/nextlist-status.log 2>&1 < /dev/null &
for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:3000/api/health > /dev/null && break
  sleep 1
done
curl -sf -o /dev/null http://127.0.0.1:3000/api/health && echo "NextList UP" || { echo "NextList FAILED"; tail -30 /tmp/nextlist-status.log; exit 1; }

node scripts/test-status-display.mjs
RC=$?

pkill -f "vite --port 3000" 2>/dev/null
exit $RC
