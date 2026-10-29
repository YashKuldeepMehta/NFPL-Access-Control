#!/usr/bin/env bash
# ~5 minute walkthrough against a running backend (npm run dev:backend) with the sample data loaded.
# Usage: bash demo/demo.sh          (set BASE=http://host:port to change the address)
# Needs only bash, curl and node (no jq).
BASE=${BASE:-http://localhost:3000}

# j '<javascript expression using d>'  reads JSON on stdin and prints the expression
j() { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{let d;try{d=JSON.parse(s)}catch(e){console.log(s);return}const r=($1);console.log(typeof r==='string'?r:JSON.stringify(r,null,2))})"; }
as() { local who=$1; shift; curl -s -H "X-User-Email: ${who}@nfpl.test" -H 'Content-Type: application/json' "$@"; }
say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
id_of() { as vikram "$BASE/users" | j "d.items.find(u=>u.email==='$1@nfpl.test').id"; }

# The seed plants these jobs first, so their ids are stable: 1 = SoD demo, 2 = filed, 7 = Cobalt history
SOD=1; FILED=2; COBALT=7
ASHA=$(id_of asha); RAVI=$(id_of ravi); VIK=$(id_of vikram)

say "1. The service is up"
curl -s $BASE/health | j 'd'

say "2. Ravi (Checker: Acme + Mumbai + imports only) MAY check job $SOD -> allowed, with the reason"
as ravi "$BASE/can?action=job.check&job=$SOD" | j '({allowed:d.allowed, reason:d.reason_code, summary:d.summary})'

say "3. Asha is a qualified Checker for Acme, but she PREPARED it -> denied by separation of duties"
as asha "$BASE/can?action=job.check&job=$SOD" | j '({allowed:d.allowed, reason:d.reason_code, checks:d.checks.map(c=>(c.pass===true?"[x] ":c.pass===false?"[ ] ":"[-] ")+c.name+": "+c.detail)})'

say "4. 'Why can she do this and he can't?'  (Ravi vs Asha, asked by the Access Admin)"
as vikram "$BASE/explain/compare?a=$RAVI&b=$ASHA&action=job.check&job=$SOD" | j '({differs_at:d.difference.check, sentence:d.sentence})'

say "5. Jobs waiting for me: the count equals what can() allows (same query)"
for u in asha ravi karan zoya parser; do printf '%-7s ' $u; as $u "$BASE/me/worklist/count" | j 'd.count'; done

say "6. A client-side user sees only their own client, no internal fields, and cannot act"
as zoya "$BASE/jobs?limit=2" | j 'd.items.map(x=>({job:x.job_no, client:x.client_name, redacted:x.redacted}))'
as zoya -X POST "$BASE/jobs/$SOD/actions/job.check" | j 'd.error.code+": "+d.error.message'

say "7. A filed job needs reason + a SECOND person: Sunita asks, Rajesh approves, Sunita executes"
printf 'Sunita acts directly:        '; as sunita -X POST "$BASE/jobs/$FILED/actions/job.cancel_filed" -d '{"reason":"Client withdrew"}' | j 'd.error.code'
AP=$(as sunita -X POST "$BASE/jobs/$FILED/approvals" -d '{"action":"job.cancel_filed","reason":"Client withdrew the shipment"}' | j 'd.id')
echo "Sunita requested approval #$AP"
printf 'Sunita approves her own:     '; as sunita -X POST "$BASE/approvals/$AP/decide" -d '{"decision":"approve"}' | j 'd.error.code'
printf 'Rajesh approves:             '; as rajesh -X POST "$BASE/approvals/$AP/decide" -d '{"decision":"approve"}' | j 'd.status'
printf 'Sunita executes:             '; as sunita -X POST "$BASE/jobs/$FILED/actions/job.cancel_filed" -d "{\"approval_id\":$AP}" | j 'd.job_no+" -> "+d.stage'

say "8. Admin self-escalation is refused (and logged)"
as vikram -X POST "$BASE/grants" -d "{\"user_id\":$VIK,\"role_code\":\"maker\",\"reason\":\"more power\"}" | j 'd.error.code+": "+d.error.message'

say "9. A job's history (who did what, including denied attempts)"
as dev "$BASE/jobs/$SOD/history" | j 'd.events.map(e=>e.summary)'

say "10. 'Who could have changed job $COBALT 15 days ago?' vs today (Tina's Cobalt grant ended 10 days ago)"
THEN=$(node -e "console.log(new Date(Date.now()-15*864e5).toISOString())")
NOW=$(node -e "console.log(new Date().toISOString())")
printf '15 days ago: '; as vikram "$BASE/jobs/$COBALT/who-could-act?action=job.check&at=$THEN" | j 'JSON.stringify(d.who.map(w=>w.name))'
printf 'today:       '; as vikram "$BASE/jobs/$COBALT/who-could-act?action=job.check&at=$NOW"  | j 'JSON.stringify(d.who.map(w=>w.name))'
echo
