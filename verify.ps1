param(
  [switch]$SkipAI
)

$root = $PSScriptRoot
$failures = New-Object System.Collections.Generic.List[string]

# Each step is run as a command string so that a non-zero exit code is read
# from $LASTEXITCODE. An earlier version used `exit` inside a scriptblock,
# which terminates the whole script rather than the step.
function Step($name, $dir, $cmd) {
  Write-Output ""
  Write-Output "--- $name  [$(Get-Date -Format 'HH:mm:ss')]"
  Push-Location $dir
  try {
    Invoke-Expression $cmd 2>&1 | ForEach-Object { Write-Output "    $_" }
    $code = $LASTEXITCODE
  } catch {
    Write-Output "    EXCEPTION: $_"
    $code = 1
  } finally {
    Pop-Location
  }
  if ($code -ne 0 -and $null -ne $code) {
    $failures.Add("$name (exit $code)")
    Write-Output "  !!! FAILED: $name (exit $code)"
  } else {
    Write-Output "  ok: $name"
  }
}

function Section($name) {
  Write-Output ""
  Write-Output "=============================================================="
  Write-Output "== $name"
  Write-Output "=============================================================="
}

$backend = Join-Path $root "backend"
$web = Join-Path $root "web"

$env:DATABASE_URL = "postgresql+asyncpg://canens:canens_dev_pass@localhost:5432/canens_test"
$env:PYTHONPATH = $backend

Write-Output "Canens verification started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Output "AI tests: $(if ($SkipAI) { 'skipped' } else { 'enabled' })"

Section "Infrastructure"
Step "compose services" $root "docker compose ps --format '{{.Name}} {{.State}} {{.Status}}'"
Step "postgres accepting connections" $root "docker compose exec -T db pg_isready -U canens -d canens"
Step "databases present" $root "docker compose exec -T db psql -U canens -d canens -tAc `"select datname from pg_database where datistemplate = false order by 1`""

Section "Backend"
Step "all modules import" $backend ".\venv\Scripts\python.exe -c `"import app.main, app.deps, app.migrate, app.schemas, app.services.bedrock, app.routers.ai, app.routers.backup, app.lambda_handler; print('ok')`""
Step "migrations match the models" $backend ".\venv\Scripts\python.exe -m pytest tests/test_migrations.py -q"
Step "full backend suite" $backend ".\venv\Scripts\python.exe -m pytest -q"
Step "no live references to removed modules" $backend "Select-String -Path (Get-ChildItem -Recurse -Include *.py -Path app,tests | ForEach-Object FullName) -Pattern 'services\.llm|websocket|sync_engine|routers\.sync|routers\.goals|routers\.tasks|requires_high_energy|EnergyLevel|WorkBlockStatus|api\.groq|OLLAMA_BASE_URL|GROQ_API_KEY' -ErrorAction SilentlyContinue"
Step "bedrock stop reasons match the real enum" $backend ".\venv\Scripts\python.exe -c `"import gzip,json,os,pathlib,botocore; base=os.path.join(os.path.dirname(botocore.__file__),'data','bedrock-runtime','2023-09-30'); m=json.loads(gzip.open(os.path.join(base,'service-2.json.gz'),'rt',encoding='utf-8').read()); op=m['operations']['Converse']; out=m['shapes'][op['output']['shape']]; enum=set(m['shapes'][out['members']['stopReason']['shape']]['enum']); src=pathlib.Path('app/services/bedrock.py').read_text(); import re; used=set(re.findall(r'==\s*.(max_tokens|end_turn|tool_use|stop_sequence|guardrail_intervened|content_filtered|malformed_model_output|malformed_tool_use|model_context_window_exceeded).', src)); assert used <= enum, f'code compares against values Bedrock never returns: {used-enum}'; print('compares only against real stop reasons:', sorted(used))`""

Section "Web"
Step "lint" $web "npm run lint"
Step "typecheck" $web "npm run typecheck"
Step "unit tests" $web "npm test"
Step "static export build" $web "npm run build"
Step "export emits directory indexes" $web "if (Test-Path out\index.html) { if (Test-Path out\activity\index.html) { 'index.html and activity/index.html present' } else { throw 'activity/index.html missing' } } else { throw 'index.html missing' }"
Step "no source outside basePath-sensitive patterns" $web "Select-String -Path (Get-ChildItem -Recurse -Include *.tsx,*.ts -Path app,components,lib | ForEach-Object FullName) -Pattern 'fetch\(`/api|href=\"/|src=\"/' -ErrorAction SilentlyContinue"

Section "End to end, no backend"
Remove-Item Env:CANENS_E2E_API -ErrorAction SilentlyContinue
Remove-Item Env:CANENS_E2E_AI -ErrorAction SilentlyContinue
$env:NEXT_PUBLIC_API_URL = ""
Step "e2e standalone" $web "npm run test:e2e"

Section "End to end, live backend"
$env:CANENS_E2E_API = "1"
$env:NEXT_PUBLIC_API_URL = "http://127.0.0.1:8000"
Step "e2e with backup round trip" $web "npm run test:e2e"

if (-not $SkipAI) {
  Section "End to end, real Bedrock"
  $env:CANENS_E2E_AI = "1"
  Step "e2e with live model calls" $web "npm run test:e2e"
  Step "calls recorded against today" $root "docker compose exec -T db psql -U canens -d canens -tAc `"select day, calls from ai_usage order by day desc limit 1`""
}

Section "Result"
if ($failures.Count -eq 0) {
  Write-Output "ALL CHECKS PASSED  $(Get-Date -Format 'HH:mm:ss')"
} else {
  Write-Output "FAILURES ($($failures.Count)):"
  $failures | ForEach-Object { Write-Output "  - $_" }
}
Write-Output "Canens verification finished $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
