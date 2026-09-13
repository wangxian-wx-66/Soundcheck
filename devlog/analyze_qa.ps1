$raw = (Get-Content 'C:\Soundcheck\devlog\test4_qa.json' -Raw -Encoding UTF8) -replace '^\uFEFF',''
$json = $raw | ConvertFrom-Json
$answers = $json.Data.Answers
if (-not $answers) { Write-Output "keys: $($json.Data.PSObject.Properties.Name -join ',')"; $answers = $json.Data.Items }
Write-Output ("answers={0} isEnd={1}" -f $answers.Count, $json.Data.Paging.IsEnd)
$votes = ($answers | ForEach-Object { [int]$_.VoteUpCount })
Write-Output ("VoteUpCount: max={0} over1000={1} over100={2} under10={3}" -f ($votes | Measure-Object -Maximum).Maximum, ($votes | Where-Object {$_ -ge 1000}).Count, ($votes | Where-Object {$_ -ge 100}).Count, ($votes | Where-Object {$_ -lt 10}).Count)
Write-Output ("descending={0}" -f (($votes -join ',') -eq (($votes | Sort-Object -Descending) -join ',')))
Write-Output ("top5 votes: " + (($votes | Select-Object -First 5) -join ','))
$lens = ($answers | ForEach-Object { if ($_.Summary) { $_.Summary.Length } else { $_.ContentText.Length } })
Write-Output ("summary chars: min={0} max={1} avg={2:n0}" -f ($lens | Measure-Object -Minimum).Minimum, ($lens | Measure-Object -Maximum).Maximum, ($lens | Measure-Object -Average).Average)
Write-Output ("fields of first: " + ($answers[0].PSObject.Properties.Name -join ','))
