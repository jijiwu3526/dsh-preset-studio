<#
.SYNOPSIS
    Control which tool-providing bundles the DSH profile injects.

.DESCRIPTION
    Why this exists
    ---------------
    An agent preset is an OVERLAY, not a replacement. From the official package
    docs (@deepseek-ai/dsh-agent-presets README):

        "A session composed from a preset runs the plugins listed in that
         preset's agent.cordis.yml. Without this package, a session can only
         fall back to what the host composition mounts."

    So a preset can ADD tools and can shadow a row's config, but it cannot
    REMOVE a tool that the host profile already injects. In a stock web
    profile the host injects 100+ tools (agent-teams, browser, univer,
    taskboard, mnemon, logicprobe, code-index, free-search, ...). Trimming
    `agent.cordis.yml` alone therefore changes almost nothing measurable.

    The layer that CAN turn them off is the profile's own patch file,
    `~/.dsh/profiles/<profile>/cordis.patch.yml`, because it is applied AFTER
    every bundle layer. A `- id: <row>` entry with `disabled: true` wins.

    This script edits that one file, and only that file.

    Row ids are NOT always the bundle name. `dsh-mnemon` injects a
    `cordis:group` whose row id is `mnemon-bundle`, so
    `- id: mnemon` silently does nothing. Always verify with -Verify.

    Scope: the change is PROFILE-WIDE, affecting every new session in this
    profile. It is not a per-session override. Running sessions keep the tool
    schema they were created with.

.NOTES
    The web profile ships "patchReload": "live", so edits normally apply
    without restarting DSH. Start a NEW session to observe the smaller set.
#>
[CmdletBinding(DefaultParameterSetName='State')]
param(
    [Parameter(ParameterSetName='Off')][string[]]$Off,
    [Parameter(ParameterSetName='On')][string[]]$On,
    [Parameter(ParameterSetName='State')][switch]$State,
    [Parameter(ParameterSetName='Verify')][switch]$Verify,
    [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

$patch = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\cordis.patch.yml"

# Row ids observed in a stock `dsh web` profile that inject model-facing tools.
# Deliberately EXCLUDED: the two skeleton bundles. `@deepseek-ai/dsh-base` and
# `@deepseek-ai/dsh-web-app` own the registries, sandbox, approval stack,
# persistence and model route. Disabling them does not trim tools; it breaks
# the host.
$Known = @(
    'dsh-tool-turbo'      # subagent / fork / interrupt_agent / list_agents
    'modsearch'           # read_page, platform_search, x_search
    'web-search-free'     # web_search, advanced_search
    'univer'              # ~15 univer_* tools
    'mnemon-bundle'       # ~15 mnemon_* tools  (NOT "mnemon")
    'dsh-taskboard'       # ~11 taskboard_* tools
    'logicprobe'          # 6 logicprobe_* verification tools
    'code-index'          # 7 code_* tools
    'agent-teams'         # ~15 agent_teams_* tools
    'bridge-browser'      # ~12 browser_* tools
    'modlens'             # vision
    'dsh-worktree'        # agent tools, inserted via - insert:, not a row
)

function Get-PatchText { [System.IO.File]::ReadAllText($patch, [Text.Encoding]::UTF8) }

function Save-PatchText([string]$t) {
    # UTF8 without BOM: PowerShell 5.1's Set-Content would rewrite as ANSI and
    # mangle the CJK comments in this file.
    [System.IO.File]::WriteAllText($patch, $t, (New-Object Text.UTF8Encoding($false)))
}

# Read the COMPOSED config, which is the only trustworthy view: it includes
# every bundle layer plus the patch, and shows the evaluated `disabled` flag.
function Get-ComposedRows {
    $raw = & dsh --profile $Profile --dump-config 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "dsh --dump-config failed:`n$raw" }
    $lines = $raw -split "`n"
    $rows = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^(\s*)- id:\s*(\S+)\s*$') {
            $indent = $Matches[1].Length
            $id     = $Matches[2]
            $body   = @()
            for ($j = $i + 1; $j -lt $lines.Count; $j++) {
                if ($lines[$j] -match '^(\s*)- id:' -and $Matches[1].Length -le $indent) { break }
                $body += $lines[$j]
            }
            $rows += [pscustomobject]@{
                Id       = $id
                Indent   = $indent
                Disabled = (($body -join "`n") -match 'disabled:\s*true')
            }
        }
    }
    return $rows
}

if (-not (Test-Path $patch)) { throw "profile patch not found: $patch" }

switch ($PSCmdlet.ParameterSetName) {

    'State' {
        $t = Get-PatchText
        $off = [regex]::Matches($t, '(?ms)^- id:\s*(\S+)\s*\r?\n\s*disabled:\s*true') |
               ForEach-Object { $_.Groups[1].Value }
        if (@($off).Count -eq 0) { 'nothing disabled — the full tool set is available' }
        else { 'disabled by this profile patch: ' + (@($off) -join ', ') }
        ''
        'note: modlens may also be disabled by hand in this file; that is expected.'
        return
    }

    'Verify' {
        $rows = Get-ComposedRows
        '{0,-22} {1}' -f 'ROW', 'DISABLED'
        '---' -f '' | Out-Null
        foreach ($id in $Known) {
            $r = $rows | Where-Object { $_.Id -eq $id } | Select-Object -First 1
            if (-not $r) { '{0,-22} {1}' -f $id, 'ROW NOT IN COMPOSED CONFIG' }
            else { '{0,-22} {1}' -f $id, $r.Disabled }
        }
        ''
        'A row reported as not-disabled may still be shadowed by a deeper row of'
        'the same id. Trust the composed config only after a live session check.'
        return
    }

    { $_ -eq 'Off' -or $_ -eq 'On' } {
        $targets = if ($PSCmdlet.ParameterSetName -eq 'Off') { $Off } else { $On }
        $want    = ($PSCmdlet.ParameterSetName -eq 'Off')
        $text    = Get-PatchText

        if ($targets -contains 'dsh-base' -or $targets -contains 'dsh-web-app') {
            throw 'refusing to touch the host skeleton (dsh-base / dsh-web-app)'
        }

        $unknown = $targets | Where-Object { $_ -notin $Known }
        if ($unknown) { Write-Warning "not in the known list, applying anyway: $($unknown -join ', ')" }

        foreach ($id in $targets) {
            $block = "(?ms)^- id:\s*$([regex]::Escape($id))\s*\r?\n(.*?)(?=^- id:|\z)"
            $m = [regex]::Match($text, $block)

            if (-not $m.Success) {
                if ($want) {
                    $text = $text.TrimEnd() + "`n`n- id: $id`n  disabled: true`n"
                    Write-Host "+ disabled $id (row appended)"
                } else {
                    Write-Warning "- $id has no row in the patch file; nothing to enable"
                }
                continue
            }

            $body = $m.Groups[1].Value
            if ($want) {
                $stripped = [regex]::Replace($body, '(?m)^[ \t]*disabled:\s*(true|false)\s*\r?\n', '')
                $newBody  = $stripped.TrimEnd() + "`n  disabled: true`n"
            } else {
                $stripped = [regex]::Replace($body, '(?m)^[ \t]*disabled:\s*true\s*\r?\n', '')
                # Drop the row entirely when enabling leaves it empty; an empty
                # `- id: x` with no body is not a valid no-op.
                $newBody = if ($stripped.Trim()) { $stripped.TrimEnd() + "`n" } else { '' }
            }
            $rebuilt = if ($newBody) { "- id: $id`n" + $newBody } else { '' }
            $text = $text.Substring(0, $m.Index) + $rebuilt + $text.Substring($m.Index + $m.Length)
            Write-Host ("{0} {1}" -f $(if ($want) { 'disabled' } else { 'enabled ' }), $id)
        }

        Save-PatchText $text
        ''
        "patch written: $patch"
        'Start a NEW session to pick up the smaller tool set.'
    }
}
