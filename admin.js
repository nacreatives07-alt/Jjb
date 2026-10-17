import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, getDocs, getDoc, doc, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { getStorage, ref as storageRef, getBlob } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import { firebaseConfig, FIREBASE_READY } from './firebase-config.js';
const $=id=>document.getElementById(id);let app,auth,db,functions,storage,verified=false,workerCache=[],attendanceCache=[],dutySummaryCache=[],selectedProfileId=null,selectedLocationWorkerId=null,locationHistoryCache=[];
if(FIREBASE_READY){app=initializeApp(firebaseConfig);auth=getAuth(app);db=getFirestore(app);functions=getFunctions(app);storage=getStorage(app);
 // Always start locked, even if Firebase Auth persisted an earlier admin session.
 signOut(auth).catch(()=>{});
}
else {$('authMsg').textContent='Setup required: add your Firebase web config in firebase-config.js. Demo mode is intentionally disabled for security.';$('adminLogin').disabled=true;}
$('adminLogin').onclick=async()=>{try{const password=$('adminPassword').value;if(!password)throw Error('Enter admin password.');$('authMsg').textContent='Verifying admin password…';const r=await httpsCallable(functions,'adminPasswordLogin')({password});await (await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js')).signInWithCustomToken(auth,r.data.token);const token=await auth.currentUser.getIdTokenResult(true);if(!token.claims.admin)throw Error('Admin permission missing.');verified=true;$('adminPassword').value='';$('authMsg').textContent='Admin unlocked.';$('adminDashboard').hidden=false;$('adminLogin').disabled=true;$('adminPassword').disabled=true;await loadWorkers();}catch(e){$('authMsg').textContent=e.message||'Admin login failed.'}};
$('adminLogout').onclick=async()=>{verified=false;workerCache=[];attendanceCache=[];dutySummaryCache=[];selectedProfileId=null;selectedLocationWorkerId=null;locationHistoryCache=[];$('adminDashboard').hidden=true;$('adminLogin').disabled=false;$('adminPassword').disabled=false;$('adminPassword').value='';$('authMsg').textContent='Admin signed out. Enter password to unlock again.';if(auth)try{await signOut(auth);}catch{};};
$('refresh').onclick=()=>loadWorkers();
$('workerSearch').addEventListener('input',renderWorkers);
$('saveTask').onclick=async()=>{try{if(!verified)throw Error('Admin login required.');const workerId=$('taskWorkerId').value.trim().toUpperCase();const task=$('assignedTask').value.trim();$('taskMsg').textContent='Saving task…';await httpsCallable(functions,'assignWorkerTask')({workerId,task});$('taskMsg').textContent=`Task updated for ${workerId}.`;$('taskWorkerId').value=workerId;await loadWorkers();}catch(e){$('taskMsg').textContent=e.message||'Could not update task.'}};
$('createWorker').onclick=async()=>{try{if(!verified)throw Error('Admin login required.');$('createMsg').textContent='Creating worker…';const result=await httpsCallable(functions,'createWorkerProfile')({workerId:$('newWorkerId').value.trim().toUpperCase(),name:$('newWorkerName').value.trim(),phone:$('newWorkerPhone').value.trim(),password:$('newWorkerPassword').value});$('createMsg').textContent=`Worker ${result.data.workerId} created successfully. Give the password to the worker securely.`;$('newWorkerId').value='';$('newWorkerName').value='';$('newWorkerPhone').value='';$('newWorkerPassword').value='';await loadWorkers();}catch(e){$('createMsg').textContent=e.message||'Could not create worker.'}};
async function loadWorkers(){
 if(!verified){$('workers').textContent='Admin login required.';return;}
 $('workers').textContent='Loading worker directory and latest activity…';
 try{
  const snap=await getDocs(collection(db,'workers'));
  const base=snap.docs.map(d=>({id:d.id,...d.data()}));
  // Enrich each directory record with its latest attendance and GPS point. Failures are
  // recorded per worker so one missing/denied subcollection does not hide every worker.
  workerCache=await Promise.all(base.map(async w=>{
   const item={...w,lastAttendance:null,lastLocation:null,todayHoliday:null,activityReadError:false};
   try{const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const h=await getDoc(doc(db,'workers',w.id,'holidays',today));if(h.exists())item.todayHoliday={...h.data(),date:today};else item.todayHoliday={date:today,marked:false};}catch(err){item.holidayReadError=true;}
   try{
    const [a,l]=await Promise.all([
     getDocs(query(collection(db,'workers',w.id,'attendance'),orderBy('timestamp','desc'),limit(1))),
     getDocs(query(collection(db,'workers',w.id,'locations'),orderBy('timestamp','desc'),limit(1)))
    ]);
    if(!a.empty){const d=a.docs[0].data();item.lastAttendance={...d,id:a.docs[0].id,timestamp:asDate(d.timestamp)};}
    if(!l.empty){const d=l.docs[0].data();item.lastLocation={...d,id:l.docs[0].id,timestamp:asDate(d.timestamp)};}
   }catch(err){item.activityReadError=true;item.activityError=err.message||'Activity unavailable';}
   return item;
  }));
  renderWorkers();
 }catch(e){$('workers').textContent='Could not load workers: '+e.message}
}
function renderWorkers(){const box=$('workers');if(!verified){box.textContent='Admin login required.';return;}const term=($('workerSearch')?.value||'').trim().toLowerCase();const rows=workerCache.filter(x=>`${x.name||''} ${x.id} ${x.phone||''}`.toLowerCase().includes(term));box.replaceChildren();if(!rows.length){box.textContent=workerCache.length?'No workers match your search.':'No workers created yet.';return;}rows.forEach(x=>{const el=document.createElement('div');el.className='worker';const title=document.createElement('strong');title.textContent=`${x.name||'Unnamed worker'} — ${x.id}`;const detail=document.createElement('p');const holidayText=x.todayHoliday?.markedAt||x.todayHoliday?.workerId?`Holiday: MARKED (${x.todayHoliday.date})`:`Holiday: NOT MARKED (${x.todayHoliday?.date||'today'})`;detail.textContent=`Phone: ${x.phone||'—'} • Status: ${x.status||'Not checked in'} • Task: ${x.task||'—'} • ${holidayText}${x.holidayReadError?' • Holiday status unavailable':''}`;
 const activity=document.createElement('p');activity.className='muted';
 const attendanceText=x.lastAttendance?`${x.lastAttendance.type||'Attendance'} at ${dateValue(x.lastAttendance.timestamp)}`:'No attendance event found';
 let gpsText='No GPS point recorded';
 if(x.lastLocation?.timestamp){const age=Math.max(0,Date.now()-x.lastLocation.timestamp.getTime());const ageLabel=age<60000?'just now':age<3600000?`${Math.floor(age/60000)} min ago`:age<86400000?`${Math.floor(age/3600000)} hr ago`:`${Math.floor(age/86400000)} day(s) ago`;gpsText=`GPS ${ageLabel} (${dateValue(x.lastLocation.timestamp)})`;}
 activity.textContent=`Last activity: ${attendanceText} • ${gpsText}${x.activityReadError?' • Some activity records could not be read':''}`;
 const gpsAlert=document.createElement('p');gpsAlert.className='activity-alert';
 if(!x.lastLocation)gpsAlert.textContent='GPS alert: no location sample has been saved.';
 else if(!x.lastLocation.timestamp)gpsAlert.textContent='GPS status: a saved point exists, but its timestamp is unavailable.';
 else if(Date.now()-x.lastLocation.timestamp.getTime()>30*60*1000)gpsAlert.textContent='GPS alert: latest saved point is older than 30 minutes. This does not prove the worker is offline.';
 else gpsAlert.textContent='GPS status: recent saved point available.';
 const b=document.createElement('button');b.textContent='View latest location';b.onclick=()=>{ $('taskWorkerId').value=x.id; $('assignedTask').value=x.task||''; loadLatest(x.id); };const profileBtn=document.createElement('button');profileBtn.className='secondary';profileBtn.textContent='View profile';profileBtn.onclick=()=>showWorkerProfile(x.id);const historyBtn=document.createElement('button');historyBtn.className='secondary';historyBtn.textContent='View attendance';historyBtn.onclick=()=>loadWorkerHistory(x.id);const routeBtn=document.createElement('button');routeBtn.className='secondary';routeBtn.textContent='View route';routeBtn.onclick=()=>{selectedLocationWorkerId=x.id;$('locationHistoryMsg').textContent=`Selected ${x.id}. Choose dates if needed, then load history.`;loadLocationHistory();};el.append(title,detail,activity,gpsAlert,b,profileBtn,historyBtn,routeBtn);box.append(el)});}

function showWorkerProfile(id){
 const w=workerCache.find(x=>x.id===id);if(!w)return;selectedProfileId=id;const box=$('workerProfile');box.replaceChildren();
 const addField=(labelText,id,value,type='text')=>{const label=document.createElement('label');label.textContent=labelText;const input=document.createElement('input');input.id=id;input.value=value||'';input.type=type;input.autocomplete='off';label.append(input);box.append(label);};
 const heading=document.createElement('h3');heading.textContent=`${w.name||'Worker'} (${w.id})`;box.append(heading);
 addField('Worker name','profileName',w.name||'');addField('Phone in international format','profilePhone',w.phone||'','tel');
 const status=document.createElement('p');status.textContent=`Account: ${w.active===false||w.status==='Inactive'?'Inactive':'Active'} • Created: ${dateValue(w.createdAt)}`;box.append(status);
 const save=document.createElement('button');save.textContent='Save profile';save.onclick=saveWorkerProfile;const reset=document.createElement('button');reset.className='secondary';reset.textContent='Reset worker password';reset.onclick=async()=>{const password=prompt('Enter a new worker password (at least 12 characters). Do not reuse another password.');if(password===null)return;try{if(password.length<12)throw Error('Password must be at least 12 characters.');await httpsCallable(functions,'resetWorkerPassword')({workerId:id,password});$('profileMsg').textContent='Worker password reset. Share it with the worker securely.';}catch(e){$('profileMsg').textContent=e.message||'Password reset failed.';}};const toggle=document.createElement('button');toggle.className='secondary';toggle.textContent=(w.active===false||w.status==='Inactive')?'Activate worker':'Deactivate worker';toggle.onclick=()=>toggleWorkerStatus(id,w.active===false||w.status==='Inactive');box.append(save,reset,toggle);$('profileMsg').textContent='';loadWorkerWorkPhotos(id,box);
}
async function loadWorkerWorkPhotos(id, box){
 const section=document.createElement('section');section.className='worker-photo-submissions';const heading=document.createElement('h4');heading.textContent='Submitted work photos';section.append(heading);const list=document.createElement('div');list.className='empty';list.textContent='Loading submitted photos…';section.append(list);box.append(section);
 try{
  const snap=await getDocs(query(collection(db,'workers',id,'workSubmissions'),orderBy('createdAt','desc'),limit(20)));
  list.replaceChildren();if(snap.empty){list.textContent='No work photos submitted yet.';return;}
  snap.forEach(d=>{const x=d.data();const item=document.createElement('div');item.className='history-row';const title=document.createElement('strong');title.textContent=x.note||x.fileName||'Work photo';const meta=document.createElement('p');meta.textContent=`Submitted: ${dateValue(asDate(x.createdAt))} • ${x.size?Math.round(x.size/1024)+' KB':''} • ${x.reviewStatus||'Submitted'}`;const view=document.createElement('button');view.className='secondary';view.textContent='Open work photo';view.onclick=async()=>{try{const blob=await getBlob(storageRef(storage,x.storagePath));const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=x.fileName||'work-photo';a.target='_blank';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(err){list.append(document.createTextNode(' Could not open image: '+(err.message||'permission denied')));}};item.append(title,meta,view);list.append(item);});
 }catch(e){list.textContent='Could not load work photos: '+(e.message||'unknown error');}
}
async function saveWorkerProfile(){try{if(!verified)throw Error('Admin login required.');if(!selectedProfileId)throw Error('Select a worker first.');$('profileMsg').textContent='Saving profile…';await httpsCallable(functions,'updateWorkerProfile')({workerId:selectedProfileId,name:$('profileName').value.trim(),phone:$('profilePhone').value.trim()});$('profileMsg').textContent='Worker profile updated.';await loadWorkers();showWorkerProfile(selectedProfileId);}catch(e){$('profileMsg').textContent=e.message||'Could not update profile.';}}
async function toggleWorkerStatus(id,activate){try{if(!verified)throw Error('Admin login required.');$('profileMsg').textContent=activate?'Activating worker…':'Deactivating worker…';await httpsCallable(functions,'setWorkerStatus')({workerId:id,active:activate});$('profileMsg').textContent=activate?'Worker activated.':'Worker deactivated.';await loadWorkers();showWorkerProfile(id);}catch(e){$('profileMsg').textContent=e.message||'Could not update worker status.';}}

async function loadLatest(id){try{const q=query(collection(db,'workers',id,'locations'),orderBy('timestamp','desc'),limit(1));const s=await getDocs(q);if(s.empty){$('location').textContent=`No location records for ${id}.`;return;}const d=s.docs[0].data();const lat=Number(d.lat),lng=Number(d.lng);const time=d.timestamp?.toDate?.().toLocaleString()||'time unavailable';$('location').replaceChildren();const line=document.createElement('p');line.textContent=`${id} • ${lat}, ${lng} • ${time} • Accuracy: ${d.accuracy??'—'} m`;const map=document.createElement('a');map.href=`https://www.google.com/maps?q=${encodeURIComponent(lat+','+lng)}`;map.target='_blank';map.rel='noopener noreferrer';map.textContent='Open location in Google Maps';$('location').append(line,map); }catch(e){$('location').textContent='Location read failed: '+e.message}}

$('loadAttendance').onclick=loadAttendanceReport;
$('exportAttendance').onclick=exportAttendanceCsv;
function asDate(value){if(value?.toDate)return value.toDate();if(value instanceof Date)return value;return null;}
function dateValue(value){const d=asDate(value);return d?d.toLocaleString(): '—';}
function escapeCsv(v){const s=String(v??'');return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
async function loadAttendanceReport(){
 if(!verified){$('reportMsg').textContent='Admin login required.';return;}
 $('loadAttendance').disabled=true;$('reportMsg').textContent='Loading attendance records…';$('attendanceReport').textContent='Loading…';attendanceCache=[];
 try{
  const from=$('reportFrom').value?new Date($('reportFrom').value+'T00:00:00'):null;
  const to=$('reportTo').value?new Date($('reportTo').value+'T23:59:59.999'):null;
  if(from&&to&&from>to)throw Error('From date must be on or before To date.');
  for(const worker of workerCache){
   const [snap,locationSnap]=await Promise.all([
    getDocs(query(collection(db,'workers',worker.id,'attendance'),orderBy('timestamp','desc'),limit(500))),
    getDocs(query(collection(db,'workers',worker.id,'locations'),orderBy('timestamp','desc'),limit(2000)))
   ]);
   const points=locationSnap.docs.map(pointDoc=>{const d=pointDoc.data();return {pointId:pointDoc.id,timestamp:asDate(d.timestamp),lat:d.lat??'',lng:d.lng??'',accuracy:d.accuracy??''};}).filter(p=>p.timestamp);
   snap.forEach(docSnap=>{
    const d=docSnap.data(),dt=asDate(d.timestamp);
    if((!from||!dt||dt>=from)&&(!to||!dt||dt<=to)){
     // Prefer GPS coordinates stored on the attendance event. Otherwise link the nearest
     // saved GPS point within 10 minutes; do not imply this is the exact event location.
     let lat=d.lat??'',lng=d.lng??'',accuracy='',locationMatch='event';
     if((lat===''||lng==='')&&dt){let nearest=null,delta=Infinity;for(const point of points){const diff=Math.abs(point.timestamp-dt);if(diff<delta){delta=diff;nearest=point;}}if(nearest&&delta<=10*60*1000&&nearest.lat!==''&&nearest.lng!==''){lat=nearest.lat;lng=nearest.lng;accuracy=nearest.accuracy;locationMatch='nearby GPS sample';}}
     attendanceCache.push({workerId:worker.id,workerName:worker.name||'',phone:worker.phone||'',eventId:docSnap.id,type:d.type||'',task:d.task||'',timestamp:dt,lat,lng,accuracy,locationMatch});
    }
   });
  }
  attendanceCache.sort((a,b)=>(b.timestamp?.getTime()||0)-(a.timestamp?.getTime()||0));
  renderAttendanceReport();$('exportAttendance').disabled=!attendanceCache.length;$('reportMsg').textContent=`Loaded ${attendanceCache.length} attendance event(s) for ${workerCache.length} worker(s).`;
 }catch(e){$('attendanceReport').textContent='Could not load report: '+e.message;$('reportMsg').textContent='Report loading failed.';$('exportAttendance').disabled=true;}
 finally{$('loadAttendance').disabled=false;}
}
function renderAttendanceReport(){
 const box=$('attendanceReport');box.replaceChildren();
 if(!attendanceCache.length){box.textContent='No attendance events found for the selected date range.';return;}
 const table=document.createElement('div');table.className='table-wrap';const t=document.createElement('table');
 const head=document.createElement('thead');const hr=document.createElement('tr');['Date & time','Worker','Worker ID','Event','Task','Location','GPS source / accuracy'].forEach(v=>{const th=document.createElement('th');th.textContent=v;hr.append(th)});head.append(hr);t.append(head);
 const body=document.createElement('tbody');attendanceCache.slice(0,1000).forEach(r=>{const tr=document.createElement('tr');const vals=[dateValue(r.timestamp),r.workerName,r.workerId,r.type,r.task,(r.lat!==''&&r.lng!=='')?`${r.lat}, ${r.lng}`:'—',r.lat!==''&&r.lng!==''?`${r.locationMatch||'GPS'}${r.accuracy!==''?` • ±${r.accuracy} m`:''}`:'No GPS match'];vals.forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.append(td)});body.append(tr)});t.append(body);table.append(t);box.append(table);
 if(attendanceCache.length>1000){const note=document.createElement('p');note.textContent='Showing first 1,000 rows here. CSV export includes all loaded rows.';box.append(note)}
}
function exportAttendanceCsv(){
 if(!attendanceCache.length)return;
 const headers=['DateTime','WorkerName','WorkerID','Phone','Event','Task','Latitude','Longitude','AccuracyMeters','LocationMatch'];
 const rows=attendanceCache.map(r=>[r.timestamp?.toISOString()||'',r.workerName,r.workerId,r.phone,r.type,r.task,r.lat,r.lng,r.accuracy,r.locationMatch]);
 const csv='\uFEFF'+[headers,...rows].map(row=>row.map(escapeCsv).join(',')).join('\r\n');
 const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`TrackPro_Attendance_${new Date().toISOString().slice(0,10)}.csv`;document.body.append(a);a.click();a.remove();URL.revokeObjectURL(url);
}
async function loadWorkerHistory(id){
 if(!verified){$('workerHistory').textContent='Admin login required.';return;}
 $('workerHistory').textContent=`Loading attendance for ${id}…`;
 try{const snap=await getDocs(query(collection(db,'workers',id,'attendance'),orderBy('timestamp','desc'),limit(100)));const box=$('workerHistory');box.replaceChildren();if(snap.empty){box.textContent=`No attendance history for ${id}.`;return;}snap.forEach(s=>{const d=s.data(),row=document.createElement('div');row.className='history-row';const title=document.createElement('strong');title.textContent=`${d.type||'Attendance'} — ${dateValue(d.timestamp)}`;const detail=document.createElement('p');detail.textContent=`Task: ${d.task||'—'}${d.lat!=null&&d.lng!=null?` • Location: ${d.lat}, ${d.lng}`:''}`;row.append(title,detail);box.append(row)});
 }catch(e){$('workerHistory').textContent='Could not load worker attendance: '+e.message;}
}


// Pair attendance events into daily shifts for operational review.
$('buildDutySummary').onclick=buildDutySummary;
$('exportDutySummary').onclick=exportDutySummaryCsv;
function dayKey(d){return d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'Unknown date';}
function durationLabel(ms){if(ms==null||!Number.isFinite(ms)||ms<0)return '—';const mins=Math.floor(ms/60000);return `${Math.floor(mins/60)}h ${mins%60}m`;}
function buildDutySummary(){
 if(!verified){$('summaryMsg').textContent='Admin login required.';return;}
 if(!attendanceCache.length){$('summaryMsg').textContent='First load attendance records.';$('dutySummary').textContent='No loaded attendance events.';return;}
 const events=[...attendanceCache].filter(x=>x.timestamp).sort((a,b)=>a.timestamp-b.timestamp);
 const shifts=new Map();
 for(const e of events){const key=`${e.workerId}|${dayKey(e.timestamp)}`;if(!shifts.has(key))shifts.set(key,{workerId:e.workerId,workerName:e.workerName,phone:e.phone,date:dayKey(e.timestamp),firstIn:null,lastOut:null,open:false,minutes:0,shiftCount:0,task:e.task||'',issues:[]});const s=shifts.get(key);if(e.type==='check-in'){if(s.open){s.issues.push('Repeated check-in before check-out');}else{s.firstIn ||= e.timestamp;s.open=true;s.currentIn=e.timestamp;s.shiftCount++;}if(e.task)s.task=e.task;}else if(e.type==='check-out'){if(!s.open){s.issues.push('Check-out without matching check-in');}else{const elapsed=e.timestamp-s.currentIn;if(elapsed>=0)s.minutes+=elapsed;else s.issues.push('Invalid event order');s.open=false;s.currentIn=null;s.lastOut=e.timestamp;}if(e.task)s.task=e.task;}}
 dutySummaryCache=[...shifts.values()].map(s=>({...s,open:s.open,minutesLabel:durationLabel(s.minutes),status:s.open?'MISSING CHECK-OUT':s.issues.length?'REVIEW':'Complete',issuesText:s.issues.join('; ')})).sort((a,b)=>b.date.localeCompare(a.date)||a.workerName.localeCompare(b.workerName));
 const box=$('dutySummary');box.replaceChildren();if(!dutySummaryCache.length){box.textContent='No dated attendance events available.';$('exportDutySummary').disabled=true;return;}
 const wrap=document.createElement('div');wrap.className='table-wrap';const table=document.createElement('table');const head=document.createElement('thead');const hr=document.createElement('tr');['Date','Worker','Worker ID','Task','Shifts','Recorded duty time','Status','Notes'].forEach(v=>{const th=document.createElement('th');th.textContent=v;hr.append(th)});head.append(hr);table.append(head);const body=document.createElement('tbody');
 for(const r of dutySummaryCache){const tr=document.createElement('tr');const vals=[r.date,r.workerName,r.workerId,r.task,r.shiftCount,r.minutesLabel,r.status,r.issuesText||'—'];for(const v of vals){const td=document.createElement('td');td.textContent=String(v??'—');tr.append(td);}body.append(tr);}table.append(body);wrap.append(table);box.append(wrap);$('exportDutySummary').disabled=false;const missing=dutySummaryCache.filter(x=>x.open).length;const review=dutySummaryCache.filter(x=>x.issues.length).length;$('summaryMsg').textContent=`${dutySummaryCache.length} worker-day record(s) • ${missing} missing check-out(s) • ${review} record(s) need review.`;
}
function exportDutySummaryCsv(){if(!dutySummaryCache.length)return;const headers=['Date','WorkerName','WorkerID','Phone','Task','ShiftCount','RecordedDutyMinutes','RecordedDutyTime','Status','Notes'];const rows=dutySummaryCache.map(r=>[r.date,r.workerName,r.workerId,r.phone,r.task,r.shiftCount,Math.floor(r.minutes/60000),r.minutesLabel,r.status,r.issuesText]);const csv='\uFEFF'+[headers,...rows].map(row=>row.map(escapeCsv).join(',')).join('\r\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`TrackPro_Daily_Duty_Summary_${new Date().toISOString().slice(0,10)}.csv`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}


// Admin-only location history. These are recorded GPS samples, not a guaranteed continuous route.
$('loadLocationHistory').onclick=loadLocationHistory;
$('exportLocationHistory').onclick=exportLocationHistoryCsv;
async function loadLocationHistory(){
 if(!verified){$('locationHistoryMsg').textContent='Admin login required.';return;}
 if(!selectedLocationWorkerId){$('locationHistoryMsg').textContent='Select a worker using “View route” first.';return;}
 const workerId=selectedLocationWorkerId;
 const from=$('locationFrom').value?new Date($('locationFrom').value+'T00:00:00'):null;
 const to=$('locationTo').value?new Date($('locationTo').value+'T23:59:59.999'):null;
 if(from&&to&&from>to){$('locationHistoryMsg').textContent='From date must be on or before To date.';return;}
 $('loadLocationHistory').disabled=true;$('locationHistoryMsg').textContent=`Loading recorded locations for ${workerId}…`;$('locationHistory').textContent='Loading…';locationHistoryCache=[];
 try{
  const snap=await getDocs(query(collection(db,'workers',workerId,'locations'),orderBy('timestamp','desc'),limit(2000)));
  snap.forEach(docSnap=>{const d=docSnap.data(),dt=asDate(d.timestamp);if((!from||!dt||dt>=from)&&(!to||!dt||dt<=to)){locationHistoryCache.push({workerId,pointId:docSnap.id,timestamp:dt,lat:d.lat??'',lng:d.lng??'',accuracy:d.accuracy??'',task:d.task||'',source:d.source||''});}});
  renderLocationHistory();$('exportLocationHistory').disabled=!locationHistoryCache.length;$('locationHistoryMsg').textContent=`Loaded ${locationHistoryCache.length} recorded location point(s) for ${workerId}.`;
 }catch(e){$('locationHistory').textContent='Could not load location history: '+e.message;$('locationHistoryMsg').textContent='Location history loading failed.';$('exportLocationHistory').disabled=true;}
 finally{$('loadLocationHistory').disabled=false;}
}
function renderLocationHistory(){
 const box=$('locationHistory');box.replaceChildren();if(!locationHistoryCache.length){box.textContent='No recorded location points found for this worker/date range.';return;}
 const wrap=document.createElement('div');wrap.className='table-wrap';const table=document.createElement('table');const thead=document.createElement('thead');const hr=document.createElement('tr');['Date & time','Latitude','Longitude','Accuracy (m)','Task','Map'].forEach(v=>{const th=document.createElement('th');th.textContent=v;hr.append(th)});thead.append(hr);table.append(thead);const tbody=document.createElement('tbody');
 locationHistoryCache.slice(0,1000).forEach(r=>{const tr=document.createElement('tr');const vals=[dateValue(r.timestamp),r.lat,r.lng,r.accuracy,r.task||'—'];vals.forEach(v=>{const td=document.createElement('td');td.textContent=String(v??'—');tr.append(td)});const td=document.createElement('td');if(r.lat!==''&&r.lng!==''){const a=document.createElement('a');a.href=`https://www.google.com/maps?q=${encodeURIComponent(r.lat+','+r.lng)}`;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Open map';td.append(a)}else td.textContent='—';tr.append(td);tbody.append(tr)});table.append(tbody);wrap.append(table);box.append(wrap);if(locationHistoryCache.length>1000){const note=document.createElement('p');note.textContent='Showing first 1,000 points in the table; CSV contains all loaded points.';box.append(note)}
}
function exportLocationHistoryCsv(){if(!locationHistoryCache.length)return;const headers=['WorkerID','PointID','Timestamp','Latitude','Longitude','AccuracyMeters','Task','Source'];const rows=locationHistoryCache.map(r=>[r.workerId,r.pointId,r.timestamp?.toISOString()||'',r.lat,r.lng,r.accuracy,r.task,r.source]);const csv='\uFEFF'+[headers,...rows].map(row=>row.map(escapeCsv).join(',')).join('\r\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`TrackPro_Location_History_${selectedLocationWorkerId}_${new Date().toISOString().slice(0,10)}.csv`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}


// Performance summary derived only from attendance events loaded in this report session.
let performanceCache=[];
$('buildPerformance').onclick=buildPerformanceReport;
$('exportPerformance').onclick=exportPerformanceCsv;
$('performanceWorkerFilter').addEventListener('input',renderPerformanceReport);
function buildPerformanceReport(){
 if(!verified){$('performanceMsg').textContent='Admin login required.';return;}
 if(!attendanceCache.length){$('performanceMsg').textContent='First load attendance records using the Attendance report above.';$('performanceReport').textContent='No attendance data loaded.';return;}
 const month=$('performanceMonth').value;
 const events=attendanceCache.filter(e=>e.timestamp&&(!month||dayKey(e.timestamp).startsWith(month))).slice().sort((a,b)=>a.timestamp-b.timestamp);
 const byWorker=new Map();
 for(const e of events){
  if(!byWorker.has(e.workerId))byWorker.set(e.workerId,{workerId:e.workerId,workerName:e.workerName||'',phone:e.phone||'',checkIns:0,checkOuts:0,missing:0,unmatched:0,minutes:0,openIn:null,tasks:new Set(),days:new Set()});
  const w=byWorker.get(e.workerId);w.days.add(dayKey(e.timestamp));if(e.task)w.tasks.add(e.task);
  if(e.type==='check-in'){w.checkIns++;if(w.openIn)w.missing++;else w.openIn=e.timestamp;}
  else if(e.type==='check-out'){w.checkOuts++;if(!w.openIn)w.unmatched++;else{const elapsed=e.timestamp-w.openIn;if(elapsed>=0)w.minutes+=elapsed;w.openIn=null;}}
 }
 performanceCache=[...byWorker.values()].map(w=>({...w,missing:w.missing+(w.openIn?1:0),minutesLabel:durationLabel(w.minutes),taskList:[...w.tasks].join(' | '),daysCount:w.days.size})).sort((a,b)=>a.workerName.localeCompare(b.workerName));
 renderPerformanceReport();$('exportPerformance').disabled=!performanceCache.length;
 const totals=performanceCache.reduce((a,w)=>({ins:a.ins+w.checkIns,outs:a.outs+w.checkOuts,missing:a.missing+w.missing}),{ins:0,outs:0,missing:0});
 const values=[performanceCache.length,totals.ins,totals.outs,totals.missing];
 [...$('performanceKpis').querySelectorAll('.kpi strong')].forEach((el,i)=>el.textContent=String(values[i]));
 $('performanceMsg').textContent=`${performanceCache.length} worker(s) with records in ${month||'all loaded months'}. Duty duration is based only on paired events in the loaded dataset.`;
}
function renderPerformanceReport(){
 const box=$('performanceReport');box.replaceChildren();
 const term=($('performanceWorkerFilter').value||'').trim().toLowerCase();
 const rows=performanceCache.filter(w=>`${w.workerName} ${w.workerId} ${w.phone}`.toLowerCase().includes(term));
 if(!rows.length){box.textContent=performanceCache.length?'No workers match this filter.':'Build the report after loading attendance records.';return;}
 const wrap=document.createElement('div');wrap.className='table-wrap';const table=document.createElement('table');const thead=document.createElement('thead');const hr=document.createElement('tr');
 ['Worker','Worker ID','Days with records','Check-ins','Check-outs','Missing check-out','Unmatched check-out','Recorded duty time','Tasks seen'].forEach(v=>{const th=document.createElement('th');th.textContent=v;hr.append(th)});thead.append(hr);table.append(thead);const tbody=document.createElement('tbody');
 for(const w of rows){const tr=document.createElement('tr');[w.workerName,w.workerId,w.daysCount,w.checkIns,w.checkOuts,w.missing,w.unmatched,w.minutesLabel,w.taskList||'—'].forEach(v=>{const td=document.createElement('td');td.textContent=String(v??'—');tr.append(td)});tbody.append(tr)}
 table.append(tbody);wrap.append(table);box.append(wrap);
}
function exportPerformanceCsv(){
 if(!performanceCache.length)return;
 const headers=['WorkerName','WorkerID','Phone','DaysWithRecords','CheckIns','CheckOuts','MissingCheckOut','UnmatchedCheckOut','RecordedDutyMinutes','RecordedDutyTime','TasksSeen'];
 const rows=performanceCache.map(w=>[w.workerName,w.workerId,w.phone,w.daysCount,w.checkIns,w.checkOuts,w.missing,w.unmatched,Math.floor(w.minutes/60000),w.minutesLabel,w.taskList]);
 const csv='\uFEFF'+[headers,...rows].map(row=>row.map(escapeCsv).join(',')).join('\r\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`TrackPro_Worker_Performance_${$('performanceMonth').value||new Date().toISOString().slice(0,7)}.csv`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const currentMonth=new Date();$('performanceMonth').value=`${currentMonth.getFullYear()}-${String(currentMonth.getMonth()+1).padStart(2,'0')}`;

// Phase 3.9: Admin monitoring alerts derived from saved records (not push notifications).
let alertsCache=[];
$('refreshAlerts').onclick=buildAdminAlerts;
$('alertFilter').addEventListener('change',renderAdminAlerts);
$('alertWorkerFilter').addEventListener('input',renderAdminAlerts);
$('exportAlerts').onclick=exportAdminAlertsCsv;
function buildAdminAlerts(){
 if(!verified){$('alertsMsg').textContent='Admin login required.';return;}
 const now=Date.now(),staleMs=30*60*1000,rows=[];
 for(const w of workerCache){
  const id=w.id,name=w.name||'Unnamed worker',phone=w.phone||'';
  if(w.activityReadError)rows.push({category:'system',severity:'review',workerId:id,workerName:name,phone,message:'Some activity records could not be read.',timestamp:null,details:w.activityError||''});
  if(!w.lastAttendance){rows.push({category:'attendance',severity:'review',workerId:id,workerName:name,phone,message:'No attendance event recorded yet.',timestamp:null,details:'Check whether the worker has started duty or attendance has synced.'});}
  else {
   const type=String(w.lastAttendance.type||'').toLowerCase();
   if(type==='check-in'||type==='checkin'||type==='check_in')rows.push({category:'attendance',severity:'attention',workerId:id,workerName:name,phone,message:'Latest attendance event is check-in; no later check-out is recorded.',timestamp:w.lastAttendance.timestamp,details:'Confirm with the worker before treating this as an unclosed shift.'});
  }
  if(!w.lastLocation){rows.push({category:'gps',severity:'review',workerId:id,workerName:name,phone,message:'No saved GPS point found.',timestamp:null,details:'This may mean location permission is off, GPS has not uploaded, or the worker has not started.'});}
  else if(!w.lastLocation.timestamp){rows.push({category:'gps',severity:'review',workerId:id,workerName:name,phone,message:'Latest GPS point has no usable timestamp.',timestamp:null,details:'Review the saved location record.'});}
  else if(now-w.lastLocation.timestamp.getTime()>staleMs){rows.push({category:'gps',severity:'attention',workerId:id,workerName:name,phone,message:'Latest saved GPS point is older than 30 minutes.',timestamp:w.lastLocation.timestamp,details:'A stale point does not prove the worker is offline.'});}
 }
 // Detect repeated check-ins in the currently loaded attendance report without an intervening check-out.
 if(attendanceCache.length){
  const grouped=new Map();
  for(const e of attendanceCache.filter(x=>x.timestamp).slice().sort((a,b)=>a.timestamp-b.timestamp)){
   if(!grouped.has(e.workerId))grouped.set(e.workerId,[]);grouped.get(e.workerId).push(e);
  }
  for(const [id,events] of grouped){let open=null;for(const e of events){const type=String(e.type||'').toLowerCase();if(type==='check-in'||type==='checkin'||type==='check_in'){if(open){const w=workerCache.find(x=>x.id===id)||{};rows.push({category:'attendance',severity:'attention',workerId:id,workerName:w.name||e.workerName||'Worker',phone:w.phone||e.phone||'',message:'Repeated check-in before a recorded check-out.',timestamp:e.timestamp,details:'Detected in the currently loaded date range; review manually.'});}open=e.timestamp;}else if(type==='check-out'||type==='checkout'||type==='check_out'){if(!open){const w=workerCache.find(x=>x.id===id)||{};rows.push({category:'attendance',severity:'review',workerId:id,workerName:w.name||e.workerName||'Worker',phone:w.phone||e.phone||'',message:'Check-out without a matching earlier check-in in loaded records.',timestamp:e.timestamp,details:'The matching check-in may be outside the selected date range.'});}else open=null;}}}
 }
 alertsCache=rows.sort((a,b)=>severityRank(b.severity)-severityRank(a.severity)||(b.timestamp?.getTime()||0)-(a.timestamp?.getTime()||0));
 renderAdminAlerts();$('exportAlerts').disabled=!alertsCache.length;
 const att=alertsCache.filter(a=>a.category==='attendance').length,gps=alertsCache.filter(a=>a.category==='gps').length,attention=alertsCache.filter(a=>a.severity==='attention').length;
 [...$('alertKpis').querySelectorAll('.kpi strong')].forEach((el,i)=>el.textContent=String([alertsCache.length,att,gps,attention][i]));
 $('alertsMsg').textContent=`${alertsCache.length} alert(s) derived from saved records. ${attendanceCache.length?'Attendance consistency checks also use the currently loaded attendance date range.':'Load an attendance report to check repeated or unmatched attendance events.'}`;
}
function severityRank(s){return s==='attention'?2:s==='review'?1:0;}
function renderAdminAlerts(){
 const box=$('alertsList');if(!box)return;box.replaceChildren();
 if(!verified){box.textContent='Admin login required.';return;}
 const filter=$('alertFilter').value,term=$('alertWorkerFilter').value.trim().toLowerCase();
 const rows=alertsCache.filter(a=>(filter==='all'||(filter==='critical'?a.severity==='attention':filter===a.category))&&`${a.workerName} ${a.workerId} ${a.phone}`.toLowerCase().includes(term));
 if(!rows.length){box.textContent=alertsCache.length?'No alerts match the selected filter.':'No alerts built yet. Click Refresh alerts.';return;}
 for(const a of rows){const card=document.createElement('article');card.className='alert-item';const head=document.createElement('div');head.className='row';const title=document.createElement('strong');title.textContent=`${a.workerName} — ${a.workerId}`;const badge=document.createElement('span');badge.className='alert-badge '+(a.severity==='attention'?'attention':'review');badge.textContent=a.severity==='attention'?'Needs attention':'Review';head.append(title,badge);const msg=document.createElement('p');msg.textContent=a.message;const meta=document.createElement('p');meta.className='muted';meta.textContent=`Category: ${a.category} • Time: ${dateValue(a.timestamp)} • Phone: ${a.phone||'—'}`;const details=document.createElement('p');details.textContent=a.details||'';card.append(head,msg,meta,details);box.append(card);}
}
function exportAdminAlertsCsv(){if(!alertsCache.length)return;const headers=['Category','Severity','WorkerName','WorkerID','Phone','Message','Timestamp','Details'];const rows=alertsCache.map(a=>[a.category,a.severity,a.workerName,a.workerId,a.phone,a.message,a.timestamp?.toISOString()||'',a.details]);const csv='\uFEFF'+[headers,...rows].map(row=>row.map(escapeCsv).join(',')).join('\r\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`TrackPro_Admin_Alerts_${new Date().toISOString().slice(0,10)}.csv`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
