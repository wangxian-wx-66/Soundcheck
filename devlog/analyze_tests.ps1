$files = @(
  @{Name='test1_ml'; Path='C:\Soundcheck\devlog\test1_ml.json'},
  @{Name='test2_career'; Path='C:\Soundcheck\devlog\test2_career.json'},
  @{Name='test3_self'; Path='C:\Soundcheck\devlog\test3_self.json'}
)
$allItems = @()
foreach ($f in $files) {
  $raw = (Get-Content $f.Path -Raw -Encoding UTF8) -replace '^\uFEFF',''
  $json = $raw | ConvertFrom-Json
  $items = $json.Data.Items
  $hit = ($items | Where-Object { $_.PSObject.Properties.Name -contains 'CommentInfoList' }).Count
  $commentPos = ($items | Where-Object { $_.CommentCount -gt 0 }).Count
  Write-Output ("[{0}] items={1} commentListHit={2} commentCountGt0={3}" -f $f.Name, $items.Count, $hit, $commentPos)
  $scores = ($items | ForEach-Object { [double]$_.RankingScore })
  $votes  = ($items | ForEach-Object { [int]$_.VoteUpCount })
  $auths  = ($items | ForEach-Object { $_.AuthorityLevel })
  $lens   = ($items | ForEach-Object { $_.ContentText.Length })
  $sorted = (($scores | Sort-Object -Descending) -join ',')
  Write-Output ("  RankingScore: min={0:n2} max={1:n2} descending={2}" -f ($scores | Measure-Object -Minimum).Minimum, ($scores | Measure-Object -Maximum).Maximum, (($scores -join ',') -eq $sorted))
  Write-Output ("  VoteUpCount : min={0} max={1} sum={2} over1000={3} over100={4}" -f ($votes | Measure-Object -Minimum).Minimum, ($votes | Measure-Object -Maximum).Maximum, ($votes | Measure-Object -Sum).Sum, ($votes | Where-Object {$_ -ge 1000}).Count, ($votes | Where-Object {$_ -ge 100}).Count)
  Write-Output ("  AuthorityLevel: " + (($auths | Group-Object | ForEach-Object { "L$($_.Name)x$($_.Count)" }) -join ' '))
  Write-Output ("  ContentText chars: min={0} max={1} avg={2:n0}" -f ($lens | Measure-Object -Minimum).Minimum, ($lens | Measure-Object -Maximum).Maximum, ($lens | Measure-Object -Average).Average)
  $exception = ($items | Where-Object { $_.CommentCount -gt 0 -and -not ($_.PSObject.Properties.Name -contains 'CommentInfoList') }).Count
  Write-Output ("  exception(commentCount>0 but no list) = $exception")
  $allItems += $items
}
Write-Output '--- TOTAL ---'
$totalHit = ($allItems | Where-Object { $_.PSObject.Properties.Name -contains 'CommentInfoList' }).Count
Write-Output ("items={0} listHit={1} rate={2:P0}" -f $allItems.Count, $totalHit, ($totalHit / $allItems.Count))
$votesAll = ($allItems | ForEach-Object { [int]$_.VoteUpCount })
Write-Output ("VoteAll: max={0} over1000={1} over100={2} under10={3}" -f ($votesAll | Measure-Object -Maximum).Maximum, ($votesAll | Where-Object {$_ -ge 1000}).Count, ($votesAll | Where-Object {$_ -ge 100}).Count, ($votesAll | Where-Object {$_ -lt 10}).Count)
