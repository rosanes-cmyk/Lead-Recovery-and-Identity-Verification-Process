// SF Assessor-Recorder tests. The two fixtures are the real JSON the service
// returned during calibration on 21 Sep 2026: a parcel search for block 4101
// lot 032 (547 Missouri St) and a name search for its owner.
import fs from 'node:fs'
import {
  parseSearchResults, summariseEncumbrances, encumbranceSummary,
  classifyTitle, splitTitles, splitParties, samePartyName, splitApn, searchQuery, INDEX_STARTS,
} from '../server/sources/recorder.js'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const fx = (f) => fs.readFileSync(new URL(`./fixtures/${f}.json`, import.meta.url), 'utf8')

// ---- document classification ------------------------------------------------------
console.log('\n[Recorder] What kind of document is this')
check('deed of trust is a loan', classifyTitle('DEED OF TRUST') === 'loan')
check('RECONVEYANCE is a release', classifyTitle('RECONVEYANCE') === 'release', classifyTitle('RECONVEYANCE'))
check('full-word stem, not a boundary miss', classifyTitle('FULL RECONVEYANCES') === 'release')
check('assignment is not a new loan', classifyTitle('ASSGN DEED OF TRUST') === 'loan-assignment', classifyTitle('ASSGN DEED OF TRUST'))
check('assignment of rents is not a new loan', classifyTitle('ASGT RENTS/LEASES') === 'loan-assignment')
check('abstract of judgment is a judgment', classifyTitle('ABSTRACT OF JUDGMENT') === 'judgment')
check('special tax lien', classifyTitle('303 - SPECIAL TAX LIEN A') === 'tax-lien')
check('mechanics lien', classifyTitle('MECHANICS LIEN') === 'mechanics-lien')
check('notice of default', classifyTitle('NOTICE OF DEFAULT') === 'default')
check('deed is a transfer', classifyTitle('DEED') === 'transfer')
check('grant deed is a transfer', classifyTitle('GRANT DEED') === 'transfer')
check('energy inspection is neither', classifyTitle('RES ENERGY INSPCTN') === 'other')
check('empty title is other', classifyTitle('') === 'other')
check('two titles split on the break', splitTitles('SUBSTITUTION TRUSTEE<br/>RECONVEYANCE').length === 2)
check('a release beats what it releases', parseSearchResults({ ResultCount: 1, SearchResults: [{ PrimaryDocNumber: '1', DocumentDate: '1/2/2020', FilingCode: 'SUBSTITUTION TRUSTEE<br/>RECONVEYANCE', Names: '' }] }).rows[0].kind === 'release')

// ---- parties ----------------------------------------------------------------------
console.log('\n[Recorder] Who is on the document')
const parties = splitParties('(R) WESTEN DAVID<br/>(E) WINTERS MICHAEL')
check('grantor read', parties[0].role === 'grantor' && parties[0].name === 'WESTEN DAVID')
check('grantee read', parties[1].role === 'grantee' && parties[1].name === 'WINTERS MICHAEL')
check('unlabelled party kept, not dropped', splitParties('SOMEBODY ELSE')[0].role === 'unknown')
check('empty names give no parties', splitParties('').length === 0)
check('same party matches itself', samePartyName('WINTERS MICHAEL', 'WINTERS MICHAEL'))
check('trailing detail still matches', samePartyName('WESTEN AYNUR GIRGIN', 'WESTEN AYNUR'))
check('punctuation ignored', samePartyName('IRA SVCS TRUST CO.', 'IRA SVCS TRUST CO'))
check('a shared surname is NOT a match', !samePartyName('WINTERS MICHAEL A', 'WINTERS MICHAEL P'))
check('different people do not match', !samePartyName('WINTERS MICHAEL', 'WESTEN DAVID'))
check('blank never matches', !samePartyName('', 'WINTERS MICHAEL'))

// ---- the real parcel search --------------------------------------------------------
console.log('\n[Recorder] Parcel search, block 4101 lot 032 (547 Missouri St)')
const parcel = parseSearchResults(fx('recorder-parcel'))
check('response parsed', parcel.ok === true)
check('total reported by the service', parcel.total === 55, String(parcel.total))
check('rows read', parcel.rows.length === 10)
check('document numbers kept', parcel.rows.some((r) => r.docNumber === '2023079178'))
const sale = parcel.rows.find((r) => r.docNumber === '2023079178')
check('the sale is a transfer', sale.kind === 'transfer')
check('sale parties right way round', sale.parties[0].name === 'WESTEN DAVID' && sale.parties[1].name === 'WINTERS MICHAEL')

const ps = summariseEncumbrances(parcel.rows)
check('last transfer found', ps.lastTransfer?.date === '10/23/2023', ps.lastTransfer?.date)
check('one loan since the sale, the Rocket Mortgage one', ps.loansSinceTransfer === 1, String(ps.loansSinceTransfer))
check("the seller's reconveyance is not counted as the buyer's release", ps.releasesSinceTransfer === 0)
check('one loan believed open, matching PropertyRadar', ps.likelyOpenLoans === 1)
check('no unreleased liens on this parcel', ps.unreleasedEncumbrances.length === 0)
check('no notices of default', ps.noticesOfDefault.length === 0)
check('summary says what it means', encumbranceSummary(ps) === '1 loan not shown released', encumbranceSummary(ps))
check('all five reconveyances counted as releases', (ps.counts.release || 0) === 5, JSON.stringify(ps.counts))

// ---- the name search, and why we do not use it -------------------------------------
console.log('\n[Recorder] Name search finds other people with the same name')
const byName = parseSearchResults(fx('recorder-name'))
check('name response parsed', byName.ok === true && byName.total === 6)
const judgments = byName.rows.filter((r) => r.kind === 'judgment')
check('three abstracts of judgment', judgments.length === 3)
check('they name MICHAEL A and MICHAEL P, not our owner', judgments.every((j) => /MICHAEL [AP]\b/.test(j.parties[0].name)))
check('none of them appear in the parcel search', !parcel.rows.some((r) => r.kind === 'judgment'))
check('so the parcel result carries no judgment', ps.unreleasedEncumbrances.length === 0)

// ---- request shape -----------------------------------------------------------------
console.log('\n[Recorder] The request the site makes')
const q = searchQuery({ block: '4101', lot: '032', to: '09/21/2026' })
check('parcel goes in Block and LowLot', q.Block === '4101' && q.LowLot === '032')
check('official records class', q.DocumentClass === 'OfficialRecords')
check('starts at the beginning of the online index', q.MinRecordedDate === INDEX_STARTS)
check('paging fields present', q.Rows === '100' && q.StartRow === '0')
check('second page', searchQuery({ block: '1', lot: '2', startRow: 100 }).StartRow === '100')
check('APN splits into block and lot', JSON.stringify(splitApn('4101-032')) === '{"block":"4101","lot":"032"}')
check('spaces work too', splitApn('4101 032').lot === '032')
check('lot letters survive', splitApn('6315-046F').lot === '046F')
check('nonsense APN yields nothing', splitApn('not an apn').block === '')

// ---- bad input ---------------------------------------------------------------------
console.log('\n[Recorder] Bad input')
check('non-JSON handled', parseSearchResults('<html>error</html>').ok === false)
check('missing list handled', parseSearchResults({ ResultCount: 0 }).ok === false)
check('empty list is ok, just empty', parseSearchResults({ ResultCount: 0, SearchResults: [] }).ok === true)
check('summary of nothing is empty', encumbranceSummary(summariseEncumbrances([])) === '')

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'} (${pass} passed, ${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)
