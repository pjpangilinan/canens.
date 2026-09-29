param(
  [switch]$SkipAI
)

# One command that runs every check, including the ones CI does not: the two
# end-to-end passes against a live API, and the pass that calls Bedrock for
# real. CI deliberately stops short of the billable one.
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

# Assert that nothing matches a pattern.
#
# Select-String always exits 0, so a step that merely ran it passed whatever it
# found - two of these checks were decorative until this function existed. The
# patterns are code, never prose: a comment explaining why the database is gone
# is the point of the change, not a violation of it.
function NoMatch($name, $dirs, $include, $pattern) {
  $files = @()
  foreach ($d in $dirs) {
    $files += Get-ChildItem -Recurse -Include $include -Path $d -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '__pycache__|node_modules|\.next|\\out\\|\.aws-sam' }
  }

  # An empty list used to reach Select-String with a null path, which throws,
  # and the throw was then read as a pass. A check that looked at no files has
  # checked nothing.
  if ($files.Count -eq 0) {
    Write-Output "  !!! FAILED: $name - it looked at no files, so it checked nothing"
    $script:failures.Add($name)
    return
  }

  $hits = @(
    Select-String -Path $files.FullName -Pattern $pattern -ErrorAction SilentlyContinue
  ) | Where-Object { $_ -ne $null }

  if ($hits.Count -gt 0) {
    Write-Output "  !!! $name matched, which it must not:"
    $hits | Select-Object -First 8 | ForEach-Object {
      Write-Output "      $(Split-Path $_.Path -Leaf):$($_.LineNumber): $($_.Line.Trim())"
    }
    $script:failures.Add($name)
    Write-Output "  !!! FAILED: $name"
  } else {
    Write-Output "  ok: $name ($($files.Count) files)"
  }
}

$backend = Join-Path $root "backend"
$web = Join-Path $root "web"

$env:PYTHONPATH = $backend

Write-Output "Canens verification started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Output "AI tests: $(if ($SkipAI) { 'skipped' } else { 'enabled' })"

Section "Backend"
Step "all modules import" $backend ".\venv\Scripts\python.exe -c `"import app.main, app.deps, app.schemas, app.storage, app.services.bedrock, app.services.usage, app.routers.ai, app.routers.backup, app.lambda_handler; print('ok')`""
Step "full backend suite" $backend ".\venv\Scripts\python.exe -m pytest -q"
# Absolute paths, because NoMatch is called from the repository root and the
# directories it looks in are under backend/ and web/. A relative "app" resolves
# to nothing, the file list comes back empty, and the check passes vacuously -
# which is exactly what it did before this was caught.
# Patterns target imports and attribute access, not the words. A test that
# asserts the Dockerfile no longer copies alembic.ini has to name it, and
# flagging that would make the check impossible to satisfy.
NoMatch "no live references to removed modules" @((Join-Path $backend "app"), (Join-Path $backend "tests")) "*.py" '^\s*(from|import)\s+(sqlalchemy|asyncpg|alembic|app\.(models|database|seed|migrate))|\bget_db\b|\bDATABASE_URL\b'
NoMatch "no code from the removed database" @((Join-Path $backend "app")) "*.py" '^\s*(from|import)\s+app\.(models|database|seed|migrate)\b'
NoMatch "no shared token in the client" @((Join-Path $web "app"), (Join-Path $web "components"), (Join-Path $web "lib")) @("*.ts", "*.tsx") 'X-Canens-Token|api_token'
Step "bedrock stop reasons match the real enum" $backend ".\venv\Scripts\python.exe -c `"import gzip,json,os,pathlib,botocore; base=os.path.join(os.path.dirname(botocore.__file__),'data','bedrock-runtime','2023-09-30'); m=json.loads(gzip.open(os.path.join(base,'service-2.json.gz'),'rt',encoding='utf-8').read()); op=m['operations']['Converse']; out=m['shapes'][op['output']['shape']]; enum=set(m['shapes'][out['members']['stopReason']['shape']]['enum']); src=pathlib.Path('app/services/bedrock.py').read_text(); import re; used=set(re.findall(r'==\s*.(max_tokens|end_turn|tool_use|stop_sequence|guardrail_intervened|content_filtered|malformed_model_output|malformed_tool_use|model_context_window_exceeded).', src)); assert used <= enum, f'code compares against values Bedrock never returns: {used-enum}'; print('compares only against real stop reasons:', sorted(used))`""

Section "Web"
Step "lint" $web "npm run lint"
Step "typecheck" $web "npm run typecheck"
Step "unit tests" $web "npm test"
Step "static export build" $web "npm run build"
Step "export emits directory indexes" $web "if (Test-Path out\index.html) { if (Test-Path out\activity\index.html) { 'index.html and activity/index.html present' } else { throw 'activity/index.html missing' } } else { throw 'index.html missing' }"
# Raw anchors and raw fetches only. next/link and next/image prepend basePath
# themselves, so href="/" on a <Link> is correct; a plain <a href="/"> is not
# and silently 404s on GitHub Pages, which is what this is watching for.
NoMatch "no paths that bypass basePath" @((Join-Path $web "app"), (Join-Path $web "components"), (Join-Path $web "lib")) @("*.tsx", "*.ts") '<a\s+href="/|fetch\(\s*[`''"]/api|\bsrc="/'

Section "End to end, no backend"
Remove-Item Env:CANENS_E2E_API -ErrorAction SilentlyContinue
Remove-Item Env:CANENS_E2E_AI -ErrorAction SilentlyContinue
$env:NEXT_PUBLIC_API_URL = ""
Step "e2e standalone" $web "npm run test:e2e"

if ($SkipAI) {
  Section "Skipped"
  Write-Output "The live-backend and live-model passes need the API running and"
  Write-Output "AWS credentials. Re-run without -SkipAI to include them."
} else {
  Section "End to end, live backend"
  Write-Output "Start the API first:  docker compose up -d  then  uvicorn app.main:app"
  $env:CANENS_E2E_API = "1"
  $env:NEXT_PUBLIC_API_URL = "http://127.0.0.1:8000"
  Step "e2e with backup round trip" $web "npm run test:e2e"

  Section "End to end, real Bedrock"
  $env:CANENS_E2E_AI = "1"
  Step "e2e with live model calls" $web "npm run test:e2e"
}

Section "Result"
if ($failures.Count -eq 0) {
  Write-Output "ALL CHECKS PASSED  $(Get-Date -Format 'HH:mm:ss')"
} else {
  Write-Output "FAILURES ($($failures.Count)):"
  $failures | ForEach-Object { Write-Output "  - $_" }
}
Write-Output "Canens verification finished $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
