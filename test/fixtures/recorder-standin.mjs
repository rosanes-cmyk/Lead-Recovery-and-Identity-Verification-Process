// Stands in for recorder.sfgov.org: the same form shape (inputs identified only
// by ng-model, a Search button, a Clear All link, a pager) over an endpoint with
// the same name and response shape. Lets the browser flow be proven without
// touching the city's servers.
import http from 'node:http'

const DOCS = []
for (let i = 0; i < 25; i++) {
  const year = 2023 - Math.floor(i / 5)
  DOCS.push({
    ID: String(1000 + i),
    PrimaryDocNumber: `${year}0${String(70000 + i)}`,
    DocumentDate: `${(i % 12) + 1}/${(i % 27) + 1}/${year}`,
    FilingCode: i === 0 ? 'DEED' : i === 1 ? 'DEED OF TRUST' : i === 2 ? 'ABSTRACT OF JUDGMENT' : i % 3 === 0 ? 'SUBSTITUTION TRUSTEE<br/>RECONVEYANCE' : 'DEED OF TRUST',
    Names: i === 0 ? '(R) SELLER SAM<br/>(E) BUYER BETTY' : `(R) PARTY ${i}<br/>(E) LENDER ${i}`,
    SecondaryDocNumber: '0', BookType: '', BookNumber: '', NumberOfPages: '0',
  })
}

const PAGE = `<!doctype html><html><head><title>Public Index Search</title></head><body>
<h1>Public Index Search</h1>
<button id="agree">I Agree</button>
<div id="form" style="display:none">
  <a href="#" onclick="clearAll();return false">Clear All</a>
  <label>Block</label><input ng-model="SearchRequestModel.Block" name="last-name">
  <label>Lot</label><input ng-model="SearchRequestModel.LowLot" name="last-name">
  <button onclick="doSearch(0)">Search</button>
  <div id="pager" style="display:none"><a href="#" ng-click="selectPage()" onclick="nextPage();return false">&#8250;</a></div>
  <div id="count"></div><table id="out"></table>
</div>
<script>
  let start = 0
  document.getElementById('agree').onclick = () => {
    document.getElementById('agree').style.display = 'none'
    document.getElementById('form').style.display = 'block'
  }
  function clearAll() { document.querySelectorAll('input').forEach(i => i.value = '') }
  function val(m) { return document.querySelector('input[ng-model="SearchRequestModel.' + m + '"]').value }
  async function doSearch(s) {
    start = s
    const u = '/SearchService/api/Search/GetSearchResults?DocumentClass=OfficialRecords&Block=' +
      encodeURIComponent(val('Block')) + '&LowLot=' + encodeURIComponent(val('LowLot')) + '&Rows=10&StartRow=' + s
    const r = await fetch(u)
    const d = await r.json()
    document.getElementById('count').textContent = d.ResultCount + ' Documents'
    document.getElementById('out').innerHTML = d.SearchResults.map(x => '<tr><td>' + x.PrimaryDocNumber + '</td></tr>').join('')
    document.getElementById('pager').style.display = (s + 10 < d.ResultCount) ? 'block' : 'none'
  }
  function nextPage() { doSearch(start + 10) }
</script></body></html>`

export function startStandIn(port = 0) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/SearchService/api/Search/GetSearchResults')) {
      const u = new URL(req.url, 'http://x')
      const block = u.searchParams.get('Block') || ''
      const startRow = Number(u.searchParams.get('StartRow') || 0)
      const all = block === '4101' ? DOCS : []
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ ResultCount: all.length, SearchResults: all.slice(startRow, startRow + 10) }))
    }
    res.setHeader('content-type', 'text/html')
    res.end(PAGE)
  })
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)))
}
