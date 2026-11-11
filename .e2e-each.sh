#!/bin/sh
: > .e2e-each.log
for s in stage6m stage6n stage6p stage6q stage6r stage7a stage7b stage7c stage7d stage7f stage7k stage7n perf-resume; do
  E2E_SPEC="$s.supabase.spec.ts" npm run test:e2e:supabase > ".e2e-$s.log" 2>&1
  echo "$s: $(sed 's/\x1b\[[0-9;]*m//g' ".e2e-$s.log" | grep -E '^\s+[0-9]+ (passed|failed|flaky)' | tr -s ' ' | tr '\n' ' ')" >> .e2e-each.log
done
echo ALLDONE >> .e2e-each.log
