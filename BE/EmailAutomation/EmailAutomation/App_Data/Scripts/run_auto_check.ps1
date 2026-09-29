```powershell
<#
    LOCAL TESTING - Auto Check Pipeline

    Purpose:
    Customer Email Match
        -> Unit Match
        -> Instrument Match
        -> Bank Reconciliation

    Local API:
    https://localhost:44309/

    IMPORTANT:
    1. Web.config मध्ये AutoCheckApiKey ची same value असणे आवश्यक आहे.
    2. First test BatchSize = 1 ठेवला आहे.
    3. API endpoint:
       https://localhost:44309/api/emailautomation/auto-check
#>


# ─────────────────────────────────────────────────────────────
# SETTINGS - LOCAL
# ─────────────────────────────────────────────────────────────

# Your LOCAL API URL
$ApiBaseUrl = "https://localhost:44309"

# IMPORTANT:
# Put the SAME API key that you configured in Web.config
#
# Example:
# <add key="AutoCheckApiKey"
#      value="8a7f4c2d91b34e6fa58c013d72b9e641" />

# Read from the AUTO_CHECK_API_KEY environment variable so the key is never
# committed (Web.config is git-ignored for the same reason). Set it once with:
#   [Environment]::SetEnvironmentVariable("AUTO_CHECK_API_KEY", "<key>", "User")
$ApiKey = $env:AUTO_CHECK_API_KEY
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Error "AUTO_CHECK_API_KEY environment variable is not set."
    exit 1
}

# For first testing, process only 1 thread
$BatchSize = 1

# Maximum number of API calls in one script run
$MaxBatches = 50

# Log file will be created in the same folder as this script
$LogFile = Join-Path $PSScriptRoot "auto_check.log"


# ─────────────────────────────────────────────────────────────
# API URL
# ─────────────────────────────────────────────────────────────

$url = "$($ApiBaseUrl.TrimEnd('/'))/api/emailautomation/auto-check"


# Threads that failed can be skipped in the next batch
$skip = @()


# Total counters
$totals = @{
    processed = 0
    advanced  = 0
    parked    = 0
    errors    = 0
}


# ─────────────────────────────────────────────────────────────
# LOG FUNCTION
# ─────────────────────────────────────────────────────────────

function Write-Log([string] $text) {

    $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $text

    Add-Content `
        -Path $LogFile `
        -Value $line `
        -Encoding UTF8

    Write-Output $line
}


# ─────────────────────────────────────────────────────────────
# START
# ─────────────────────────────────────────────────────────────

Write-Log "==============================================="
Write-Log "LOCAL AUTO-CHECK STARTED"
Write-Log "API URL: $url"
Write-Log "Batch Size: $BatchSize"
Write-Log "==============================================="


# ─────────────────────────────────────────────────────────────
# PROCESS BATCHES
# ─────────────────────────────────────────────────────────────

for ($batch = 1; $batch -le $MaxBatches; $batch++) {

    Write-Log "Starting batch $batch..."


    # Request body
    $body = @{
        apiKey       = $ApiKey
        maxThreads   = $BatchSize
        skipThreadIds = $skip
    } | ConvertTo-Json


    try {

        Write-Log "Calling Auto-Check API..."


        $response = Invoke-RestMethod `
            -Method Post `
            -Uri $url `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec 600


        Write-Log "API call successful."


    }
    catch {

        Write-Log "ERROR: API call failed."
        Write-Log "ERROR MESSAGE: $($_.Exception.Message)"

        break
    }


    # ─────────────────────────────────────────────
    # DISPLAY THREAD RESULTS
    # ─────────────────────────────────────────────

    if ($null -ne $response.results) {

        foreach ($r in $response.results) {

            Write-Log (
                "Thread: {0} | Ticket: {1} | From: {2} | Stopped At: {3} | Status: {4} | Message: {5}" -f `
                $r.threadId,
                $r.ticketId,
                $r.fromStep,
                $r.stoppedAt,
                $r.actionStatus,
                $r.message
            )
        }
    }


    # ─────────────────────────────────────────────
    # UPDATE TOTAL COUNTERS
    # ─────────────────────────────────────────────

    $totals.processed += $response.processed
    $totals.advanced  += $response.advanced
    $totals.parked    += $response.parked
    $totals.errors    += $response.errors


    # Add failed threads to skip list
    if ($null -ne $response.failedThreadIds) {

        $skip += @($response.failedThreadIds)
    }


    # ─────────────────────────────────────────────
    # DISPLAY BATCH SUMMARY
    # ─────────────────────────────────────────────

    Write-Log (
        "Batch {0} Summary -> Processed: {1}, Advanced: {2}, Parked: {3}, Errors: {4}, Remaining: {5}" -f `
        $batch,
        $response.processed,
        $response.advanced,
        $response.parked,
        $response.errors,
        $response.remaining
    )


    # ─────────────────────────────────────────────
    # STOP CONDITIONS
    # ─────────────────────────────────────────────

    # Queue empty
    if ($response.remaining -le 0) {

        Write-Log "No remaining threads. Queue processing completed."

        break
    }


    # API processed nothing
    if ($response.processed -eq 0) {

        Write-Log "No threads were processed in this batch."

        break
    }
}


# ─────────────────────────────────────────────────────────────
# FINAL SUMMARY
# ─────────────────────────────────────────────────────────────

Write-Log "==============================================="
Write-Log (
    "LOCAL AUTO-CHECK FINISHED -> Processed: {0}, Advanced: {1}, Parked: {2}, Errors: {3}" -f `
    $totals.processed,
    $totals.advanced,
    $totals.parked,
    $totals.errors
)
Write-Log "==============================================="
```