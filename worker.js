import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInWithCustomToken, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, getDoc, collection, addDoc, serverTimestamp, getDocs, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { getStorage, ref as storageRef, uploadBytes, getBlob } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import { firebaseConfig, FIREBASE_READY } from './firebase-config.js';
const $=id=>document.getElementById(id);
const indiaDateKey=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
let auth,db,functions,storage,workerId,watchId=null,active=false,lastPosition=null,holidayMarkedToday=false;
const nativeLocation=()=>window.Capacitor?.Plugins?.TrackProBackgroundLocation||null;
async function startNativeLocation(){const plugin=nativeLocation();if(!plugin)return false;try{const result=await plugin.startTracking({workerId,task:$('task').value.trim()});$('gpsStatus').textContent=result?.message||'Android foreground location service started.';$('gpsStatus').className='status-good';return true;}catch(e){$('gpsStatus').textContent='Native tracking could not start: '+(e.message||'permission or Android setup required');$('gpsStatus').className='status-warning';return false;}}
async function stopNativeLocation(){const plugin=nativeLocation();if(!plugin)return;try{await plugin.stopTracking();}catch(e){console.warn('Native location stop failed',e);}}
async function syncNativeLocationQueue(){
 const plugin=nativeLocation();
 if(!plugin||!db||!auth?.currentUser||!workerId||!navigator.onLine)return;
 try{
  const result=await plugin.getPendingLocations();
  const rows=result?.locations||[];
  const uploaded=[];
  for(const row of rows){
   // Never upload a point under a different worker's path. A mismatched row stays queued
   // and is surfaced as a diagnostic instead of being silently reassigned.
   if(String(row.workerId)!==String(workerId)){
    console.warn('A queued native GPS point belongs to a different Worker ID; it was not uploaded.',{queueId:row.id,queueWorkerId:row.workerId,currentWorkerId:workerId});
    continue;
   }
   const queueId=Number(row.id);
   if(!Number.isFinite(queueId))continue;
   // Stable document ID makes retries idempotent: if the write succeeded but marking the
   // local queue failed, the next sync overwrites the same point instead of duplicating it.
   const result=await httpsCallable(functions,'recordWorkerLocation')({
    workerId, queueId, lat:Number(row.lat), lng:Number(row.lng), accuracy:Number(row.accuracy||0),
    task:String(row.task||''), capturedAt:Number(row.capturedAt)
   });
   if(!result.data?.ok)throw Error('Server did not confirm a queued GPS point.');
   uploaded.push(queueId);
  }
  if(uploaded.length)await plugin.markLocationsUploaded({ids:uploaded});
 }catch(e){console.warn('Native GPS queue will retry when app is active and online',e);}
}
const workerIdKey='trackpro.lastWorkerId';
if(FIREBASE_READY){
 const app=initializeApp(firebaseConfig);auth=getAuth(app);db=getFirestore(app);functions=getFunctions(app);storage=getStorage(app);
 onAuthStateChanged(auth,async user=>{
  if(!user){$('authStatus').textContent='Sign in with your Worker ID and Admin-provided password.';return;}
  try{
   const token=await user.getIdTokenResult(); const savedId=String(token.claims.workerId||localStorage.getItem(workerIdKey)||'').toUpperCase();
   if(!savedId){$('authStatus').textContent='Worker identity missing. Sign out and log in again.';return;}
   const profileSnap=await getDoc(doc(db,'workers',savedId));
   if(!profileSnap.exists()){await signOut(auth);$('authStatus').textContent='Worker profile not found. Contact admin.';return;}
   const profile=profileSnap.data(); if(profile.active===false||profile.status==='Inactive'){await signOut(auth);$('authStatus').textContent='Worker account is inactive. Contact admin.';return;}
   workerId=savedId;localStorage.setItem(workerIdKey,savedId);$('workerId').value=savedId;$('task').value=profile.task||'';
   $('workerProfileCard').hidden=false;$('workerHistoryCard').hidden=false;$('workPhotoCard').hidden=false;$('dutyCard').hidden=false;renderWorkerProfile(profile);await loadMyWorkPhotos();await loadMyAttendanceHistory();
   $('authStatus').textContent=`Signed in as ${profile.name||savedId}.`;$('markHoliday').disabled=profile.active===false||profile.status==='Inactive'||profile.status==='On duty';
   await refreshHolidayStatus(savedId);$('checkIn').disabled=profile.status==='On duty';
   if(profile.status==='On duty'){active=true;$('checkIn').disabled=true;$('checkOut').disabled=false;$('resumeTracking').disabled=false;$('markHoliday').disabled=true;$('dutyMsg').textContent='An existing duty session was found. Tap “Resume location updates” to restart GPS updates.';}else{$('checkOut').disabled=true;$('resumeTracking').disabled=true;}
  }catch(e){$('authStatus').textContent='Could not restore duty state: '+(e.message||'unknown error');}
 });
}else{$('msg').textContent='Setup required: add Firebase config before using worker sign-in.';$('workerLogin').disabled=true;$('authStatus').textContent='Firebase is not configured.';}
function renderWorkerProfile(profile){
 const box=$('workerProfileSummary');box.replaceChildren();
 const rows=[['Worker ID',workerId],['Name',profile.name||'—'],['Phone number',profile.phone||'—'],['Assigned work',profile.task||'No task assigned yet'],['Current status',profile.status||'Active']];
 for(const [label,value] of rows){const row=document.createElement('p');const strong=document.createElement('strong');strong.textContent=label+': ';row.append(strong,document.createTextNode(String(value)));box.append(row);}
 const note=document.createElement('p');note.className='muted';note.textContent='Your profile details are managed by Admin. Contact Admin if your name, phone number, or assigned work needs correction.';box.append(note);
}
async function loadMyWorkPhotos(){
 try{
  const snap=await getDocs(query(collection(db,'workers',workerId,'workSubmissions'),orderBy('createdAt','desc'),limit(10)));
  const box=$('myWorkPhotos');box.replaceChildren();
  if(snap.empty){box.textContent='No work photos submitted yet.';return;}
  snap.forEach(d=>{const x=d.data();const item=document.createElement('div');item.className='history-row';const title=document.createElement('strong');title.textContent=x.note||'Work photo';const time=document.createElement('p');time.textContent='Submitted: '+dateLabel(x.createdAt);const status=document.createElement('p');status.textContent='Status: '+(x.reviewStatus||'Submitted');const view=document.createElement('button');view.className='secondary';view.textContent='View my photo';view.onclick=async()=>{try{const blob=await getBlob(storageRef(storage,x.storagePath));const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=x.fileName||'work-photo';a.target='_blank';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(e){$('photoMsg').textContent='Could not open photo: '+e.message;}};item.append(title,time,status,view);box.append(item);});
 }catch(e){$('myWorkPhotos').textContent='Could not load submissions: '+(e.message||'unknown error');}
}
async function loadMyAttendanceHistory(){
 try{
  const snap=await getDocs(query(collection(db,'workers',workerId,'attendance'),orderBy('timestamp','desc'),limit(15)));
  const box=$('myAttendanceHistory');box.replaceChildren();if(snap.empty){box.textContent='No attendance records yet.';return;}
  snap.forEach(d=>{const x=d.data();const row=document.createElement('div');row.className='history-row';const title=document.createElement('strong');title.textContent=String(x.type||'Attendance').replace(/-/g,' ').toUpperCase();const details=document.createElement('p');details.textContent=`${dateLabel(x.timestamp)} • ${x.task||'No task recorded'}`;row.append(title,details);box.append(row);});
 }catch(e){$('myAttendanceHistory').textContent='Could not load attendance history: '+(e.message||'unknown error');}
}
function dateLabel(value){if(!value)return 'Just now';const d=typeof value.toDate==='function'?value.toDate():new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('en-IN');}
$('submitWorkPhoto').onclick=async()=>{
 try{
  if(!auth?.currentUser||!workerId)throw Error('Please sign in first.');
  if(!navigator.onLine)throw Error('Internet connection is required to submit a photo.');
  const file=$('workPhoto').files?.[0];if(!file)throw Error('Choose a work photo first.');
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Please select a JPG, PNG or WebP image.');
  if(file.size>8*1024*1024)throw Error('Photo must be 8 MB or smaller.');
  const note=$('workPhotoNote').value.trim();if(note.length>300)throw Error('Keep the note under 300 characters.');
  $('submitWorkPhoto').disabled=true;$('photoMsg').textContent='Uploading photo securely…';
  const safeName=file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-80)||'work-photo';
  const path=`workerWorkPhotos/${workerId}/${Date.now()}_${safeName}`;
  const uploaded=await uploadBytes(storageRef(storage,path),file,{contentType:file.type,customMetadata:{workerId}});
  const result=await httpsCallable(functions,'submitWorkerWorkPhoto')({workerId,storagePath:path,note,fileName:safeName,contentType:file.type,size:file.size});
  if(!result.data?.ok)throw Error('Server did not confirm the submission.');
  $('photoMsg').textContent='Work photo submitted. Admin can review it.';$('workPhoto').value='';$('workPhotoNote').value='';await loadMyWorkPhotos();
 }catch(e){$('photoMsg').textContent=e.message||'Could not submit work photo.';}
 finally{$('submitWorkPhoto').disabled=false;}
};
function updateNetworkStatus(){
 $('networkStatus').textContent=navigator.onLine?'Internet connection: online.':'Internet connection: offline. New server writes may fail until connection returns.';
 $('networkStatus').className=navigator.onLine?'status-good':'status-warning';
}
window.addEventListener('online',updateNetworkStatus);window.addEventListener('offline',updateNetworkStatus);updateNetworkStatus();
async function updateGpsPermissionStatus(){
 if(!navigator.geolocation){$('gpsStatus').textContent='GPS: this browser does not support geolocation.';return;}
 if(!navigator.permissions?.query){$('gpsStatus').textContent='GPS: permission status will be shown when you start check-in.';return;}
 try{const p=await navigator.permissions.query({name:'geolocation'});const show=()=>{$('gpsStatus').textContent=`GPS permission: ${p.state}. Location is requested only for duty tracking.`;};show();p.onchange=show;}catch{$('gpsStatus').textContent='GPS: permission status unavailable; try check-in to request access.';}
}
updateGpsPermissionStatus();
$('workerLogout').onclick=async()=>{try{if(active)throw Error('Check out before signing out so your duty session remains clear.');await signOut(auth);localStorage.removeItem(workerIdKey);workerId=null;$('workerProfileCard').hidden=true;$('workerHistoryCard').hidden=true;$('workPhotoCard').hidden=true;$('dutyCard').hidden=true;$('msg').textContent='Signed out.';}catch(e){$('msg').textContent=e.message||'Could not sign out.';}};
$('workerLogin').onclick=async()=>{
 try{workerId=$('workerId').value.trim().toUpperCase();$('workerId').value=workerId;const password=$('workerPassword').value;if(!workerId||!password)throw Error('Enter Worker ID and password.');if(!navigator.onLine)throw Error('Internet connection required to sign in.');$('msg').textContent='Verifying Worker ID and password…';const result=await httpsCallable(functions,'workerPasswordLogin')({workerId,password});await signInWithCustomToken(auth,result.data.token);await auth.currentUser.getIdToken(true);$('workerPassword').value='';$('msg').textContent='Login successful.';
 }catch(e){$('msg').textContent=e.message||'Worker login failed.';}
};
$('checkIn').onclick=async()=>{
 try{
  if(!auth.currentUser||!workerId)throw Error('Worker login required.');if(holidayMarkedToday)throw Error('Holiday is marked for today; check-in is disabled. Contact admin if this needs correction.');if(!$('locationConsent').checked)throw Error('Please read and accept the location notice before starting duty.');if(!navigator.onLine)throw Error('Internet is offline. Reconnect before check-in so attendance can be saved.');if(active)throw Error('You are already checked in.');
  if(!navigator.geolocation)throw Error('This browser does not support location.');$('dutyMsg').textContent='Checking location permission and GPS…';
  const pos=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:20000,maximumAge:0}));
  const task=$('task').value.trim();
  lastPosition={lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:Math.round(pos.coords.accuracy)};
  const checkInResult=await httpsCallable(functions,'recordWorkerCheckIn')({workerId,task,...lastPosition});
  if(!checkInResult.data?.ok)throw Error('Check-in could not be confirmed by the server.');
  active=true;$('checkIn').disabled=true;$('checkOut').disabled=false;$('resumeTracking').disabled=false;$('markHoliday').disabled=true;$('dutyMsg').textContent='Checked in. Starting location updates…';
  try{await recordPoint(pos);}catch(locationError){$('gpsStatus').textContent='Check-in saved, but first GPS point could not sync: '+(locationError.message||'unknown error');$('gpsStatus').className='status-warning';}
  startLocationWatch();await startNativeLocation();await syncNativeLocationQueue();
 }catch(e){$('dutyMsg').textContent='Check-in failed: '+(e.message||'Could not save attendance.');}
};
function startLocationWatch(){
 if(!active||!navigator.geolocation||watchId!==null)return;
 watchId=navigator.geolocation.watchPosition(p=>recordPoint(p).then(()=>{$('gpsStatus').textContent=`GPS updating. Accuracy ±${Math.round(p.coords.accuracy)} m.`;$('gpsStatus').className='status-good';}).catch(e=>$('dutyMsg').textContent='Location save failed: '+e.message),e=>{$('gpsStatus').textContent='GPS error: '+e.message;$('gpsStatus').className='status-warning';},{enableHighAccuracy:true,maximumAge:10000,timeout:20000});
}
async function recordPoint(pos){
 if(!auth.currentUser||!workerId)return;
 lastPosition={lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:Math.round(pos.coords.accuracy)};
 await addDoc(collection(db,'workers',workerId,'locations'),{...lastPosition,timestamp:serverTimestamp(),task:$('task').value.trim(),source:'browser-geolocation'});
}
$('resumeTracking').onclick=async()=>{if(!auth.currentUser||!workerId||!active){$('dutyMsg').textContent='Restore your signed-in duty session first.';return;}if(!$('locationConsent').checked){$('dutyMsg').textContent='Accept the location notice before resuming tracking.';return;}if(!navigator.onLine){$('dutyMsg').textContent='Internet is offline. Reconnect before resuming GPS uploads.';return;}startLocationWatch();await startNativeLocation();await syncNativeLocationQueue();$('dutyMsg').textContent='Location updates resumed. Android foreground tracking is used only when the native app and permissions are available.';};
$('checkOut').onclick=async()=>{
 try{
  if(!auth.currentUser||!workerId)throw Error('Worker login required.');if(!navigator.onLine)throw Error('Internet is offline. Reconnect before check-out so attendance can be saved.');
  const task=$('task').value.trim();
  const checkOutResult=await httpsCallable(functions,'recordWorkerCheckOut')({workerId,task,...(lastPosition||{})});
  if(!checkOutResult.data?.ok)throw Error('Check-out could not be confirmed by the server.');
  if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;await stopNativeLocation();await syncNativeLocationQueue();active=false;$('checkIn').disabled=false;$('checkOut').disabled=true;$('resumeTracking').disabled=true;$('markHoliday').disabled=false;$('dutyMsg').textContent='Checked out successfully. Location updates stopped.';
 }catch(e){$('dutyMsg').textContent='Check-out failed: '+(e.message||'Could not save check-out.');}
};


$('locationConsent').addEventListener('change',async()=>{
 if(active&&!$('locationConsent').checked){
  if(watchId!==null)navigator.geolocation.clearWatch(watchId);
  watchId=null;
  await stopNativeLocation();
  $('dutyMsg').textContent='Location tracking paused because consent was withdrawn. Check out to close the active duty session; accept the notice again if you want to resume tracking.';
  $('gpsStatus').textContent='GPS tracking paused: location consent is not enabled.';
  $('gpsStatus').className='status-warning';
 }
});

window.addEventListener('online',()=>{syncNativeLocationQueue();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncNativeLocationQueue();});


async function refreshHolidayStatus(id){
 try{
  if(!db||!id)return;const date=indiaDateKey();const snap=await getDoc(doc(db,'workers',id,'holidays',date));
  holidayMarkedToday=snap.exists();$('holidayMsg').textContent=holidayMarkedToday?`Holiday marked for today (${date}). Check-in is disabled for today.`:`Holiday not marked for today (${date}).`;
  $('markHoliday').disabled=holidayMarkedToday||active;if(!active&&workerId)$('checkIn').disabled=holidayMarkedToday;
 }catch(e){$('holidayMsg').textContent='Could not load today\'s holiday status: '+(e.message||'unknown error');}
}
$('markHoliday').onclick=async()=>{
 try{
  if(!auth?.currentUser||!workerId)throw Error('Worker login required.');
  if(active)throw Error('Check out before marking a holiday.');
  if(!confirm('Mark today as a holiday? You can only mark it once per day.'))return;
  $('markHoliday').disabled=true;$('holidayMsg').textContent='Saving holiday…';
  await httpsCallable(functions,'markWorkerHoliday')({workerId,reason:$('holidayReason').value.trim()});
  $('holidayMsg').textContent=`Holiday marked for today (${indiaDateKey()}).`;
 }catch(e){$('holidayMsg').textContent=e.message||'Could not mark holiday.';await refreshHolidayStatus(workerId);}
};
