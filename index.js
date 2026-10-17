const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();
const SMTP_HOST = defineSecret('SMTP_HOST');
const SMTP_PORT = defineSecret('SMTP_PORT');
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const ADMIN_EMAILS = defineSecret('ADMIN_EMAILS');
const OTP_PEPPER = defineSecret('OTP_PEPPER');
const ADMIN_PASSWORD = defineSecret('ADMIN_PASSWORD');
const scryptAsync = (password, salt) => new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(key.toString('hex'))));
const passwordHash = async (password, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: await scryptAsync(password, salt) });
const normEmail = v => String(v || '').trim().toLowerCase();
const normPhone = v => String(v || '').replace(/[\s()-]/g, '');
const hashOtp = (email, otp, pepper) => crypto.createHmac('sha256', pepper).update(`${normEmail(email)}:${otp}`).digest('hex');
const isAdmin = req => !!req.auth && req.auth.token.admin === true;

// Password-only admin sign-in. Set ADMIN_PASSWORD as a Firebase Secret before deploying.
exports.adminPasswordLogin = onCall({ secrets: [ADMIN_PASSWORD], maxInstances: 5 }, async req => {
  const password = String(req.data?.password || '');
  const expected = ADMIN_PASSWORD.value();
  if (!expected || expected.length < 20) throw new HttpsError('failed-precondition', 'Set a strong ADMIN_PASSWORD secret (at least 20 characters) before login.');
  const a = Buffer.from(password); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpsError('permission-denied', 'Incorrect admin password.');
  const uid = 'trackpro-admin';
  const user = await admin.auth().getUser(uid).catch(async e => { if (e.code !== 'auth/user-not-found') throw e; return admin.auth().createUser({ uid, displayName: 'TrackPro Admin' }); });
  await admin.auth().setCustomUserClaims(user.uid, { ...(user.customClaims || {}), admin: true });
  return { token: await admin.auth().createCustomToken(user.uid, { admin: true }) };
});

exports.requestAdminOtp = onCall({ secrets: [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ADMIN_EMAILS, OTP_PEPPER], maxInstances: 5 }, async req => {
  const email = normEmail(req.data?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  // Rate-limit by normalized email before checking the allow-list, so the response
  // does not disclose whether an address is an authorized admin account.
  const rateKey = crypto.createHash('sha256').update(email).digest('hex');
  const rateRef = db.collection('adminOtpRateLimits').doc(rateKey);
  const now = Date.now();
  await db.runTransaction(async tx => {
    const snap = await tx.get(rateRef);
    const old = snap.exists ? snap.data() : {};
    const windowStart = Number(old.windowStart || now);
    const windowExpired = now - windowStart >= 60 * 60 * 1000;
    const count = windowExpired ? 0 : Number(old.count || 0);
    const lastRequestAt = Number(old.lastRequestAt || 0);
    if (!windowExpired && count >= 5) {
      throw new HttpsError('resource-exhausted', 'Too many OTP requests. Try again later.');
    }
    if (lastRequestAt && now - lastRequestAt < 60 * 1000) {
      throw new HttpsError('resource-exhausted', 'Please wait one minute before requesting another OTP.');
    }
    tx.set(rateRef, { windowStart: windowExpired ? now : windowStart, count: count + 1, lastRequestAt: now, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  const allow = ADMIN_EMAILS.value().split(',').map(normEmail).filter(Boolean);
  // Do not reveal whether an email is on the admin allow-list.
  if (!allow.includes(email)) return { ok: true };
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const ref = db.collection('adminOtps').doc(crypto.createHash('sha256').update(email).digest('hex'));
  await ref.set({ otpHash: hashOtp(email, otp, OTP_PEPPER.value()), expiresAt, attempts: 0, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  const port = Number(SMTP_PORT.value() || 587);
  const transporter = nodemailer.createTransport({ host: SMTP_HOST.value(), port, secure: port === 465, auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() } });
  await transporter.sendMail({ from: SMTP_USER.value(), to: email, subject: 'TrackPro Admin sign-in code', text: `Your TrackPro admin OTP is ${otp}. It expires in 10 minutes. If you did not request it, ignore this email.` });
  return { ok: true };
});

exports.verifyAdminOtp = onCall({ secrets: [ADMIN_EMAILS, OTP_PEPPER], maxInstances: 10 }, async req => {
  const email = normEmail(req.data?.email), otp = String(req.data?.otp || '').trim();
  const allow = ADMIN_EMAILS.value().split(',').map(normEmail).filter(Boolean);
  if (!allow.includes(email) || !/^\d{6}$/.test(otp)) throw new HttpsError('permission-denied', 'Invalid email or OTP.');
  const ref = db.collection('adminOtps').doc(crypto.createHash('sha256').update(email).digest('hex'));
  const result = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const d = snap.data();
    if (Date.now() > d.expiresAt || d.attempts >= 5) { tx.delete(ref); return false; }
    const expected = Buffer.from(d.otpHash, 'hex');
    const actual = Buffer.from(hashOtp(email, otp, OTP_PEPPER.value()), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) { tx.update(ref, { attempts: d.attempts + 1 }); return false; }
    tx.delete(ref); return true;
  });
  if (!result) throw new HttpsError('permission-denied', 'OTP is invalid or expired.');
  const userRecord = await admin.auth().getUserByEmail(email).catch(async e => {
    if (e.code !== 'auth/user-not-found') throw e;
    return admin.auth().createUser({ email, emailVerified: true });
  });
  await admin.auth().setCustomUserClaims(userRecord.uid, { ...(userRecord.customClaims || {}), admin: true });
  const token = await admin.auth().createCustomToken(userRecord.uid, { admin: true });
  return { ok: true, token };
});

exports.createWorkerProfile = onCall(async req => {
  if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Admin access required.');
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  const name = String(req.data?.name || '').trim();
  const phone = normPhone(req.data?.phone);
  const password = String(req.data?.password || '');
  if (password.length < 12 || password.length > 128) throw new HttpsError('invalid-argument', 'Worker password must be 12–128 characters.');
  if (!/^[A-Z0-9_-]{3,32}$/.test(workerId)) throw new HttpsError('invalid-argument', 'Worker ID must be 3–32 letters/numbers, dash or underscore.');
  if (name.length < 2 || name.length > 100) throw new HttpsError('invalid-argument', 'Enter the worker name.');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new HttpsError('invalid-argument', 'Enter phone in international format, e.g. +91XXXXXXXXXX.');
  const ref = db.collection('workers').doc(workerId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) throw new HttpsError('already-exists', 'This Worker ID already exists.');
    tx.set(ref, { workerId, name, phone, active: true, status: 'Active', task: '', createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: req.auth.uid });
  });
  const credentials = await passwordHash(password);
  await db.collection('workerCredentials').doc(workerId).set({ salt: credentials.salt, hash: credentials.hash, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.auth.uid });
  return { ok: true, workerId };
});

exports.workerPasswordLogin = onCall({ maxInstances: 10 }, async req => {
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  const password = String(req.data?.password || '');
  if (!/^[A-Z0-9_-]{3,32}$/.test(workerId) || password.length < 1 || password.length > 128) throw new HttpsError('invalid-argument', 'Enter Worker ID and password.');
  const ref = db.collection('workers').doc(workerId); const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Worker ID or password is incorrect.');
  const w = snap.data();
  if (w.active === false || w.status === 'Inactive') throw new HttpsError('permission-denied', 'Worker account is inactive. Contact admin.');
  const credentialSnap = await db.collection('workerCredentials').doc(workerId).get();
  if (!credentialSnap.exists) throw new HttpsError('failed-precondition', 'Admin must set this worker password first.');
  const credentials = credentialSnap.data();
  const actual = Buffer.from(await scryptAsync(password, credentials.salt), 'hex'); const expected = Buffer.from(credentials.hash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new HttpsError('permission-denied', 'Worker ID or password is incorrect.');
  const uid = `worker-${workerId}`;
  const user = await admin.auth().getUser(uid).catch(async e => { if (e.code !== 'auth/user-not-found') throw e; return admin.auth().createUser({ uid, displayName: w.name || workerId }); });
  await admin.auth().setCustomUserClaims(user.uid, { workerId, admin: false });
  await db.collection('users').doc(user.uid).set({ workerId, phone: w.phone || '', linkedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { token: await admin.auth().createCustomToken(user.uid, { workerId, admin: false }), workerId };
});

exports.submitWorkerWorkPhoto = onCall({ maxInstances: 20 }, async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Worker sign-in required.');
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  if (req.auth.token.workerId !== workerId || req.auth.token.admin === true) throw new HttpsError('permission-denied', 'You can submit work photos only for your own Worker ID.');
  const storagePath = String(req.data?.storagePath || '');
  const note = String(req.data?.note || '').trim().slice(0, 300);
  const fileName = String(req.data?.fileName || 'work-photo').slice(0, 100);
  const contentType = String(req.data?.contentType || '');
  const size = Number(req.data?.size || 0);
  if (!/^workerWorkPhotos\/[A-Z0-9_-]{3,32}\/[0-9]+_[A-Za-z0-9._-]{1,80}$/.test(storagePath) || !storagePath.startsWith(`workerWorkPhotos/${workerId}/`)) throw new HttpsError('invalid-argument', 'Invalid work photo path.');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType) || size < 1 || size > 8 * 1024 * 1024) throw new HttpsError('invalid-argument', 'Photo must be a JPG, PNG or WebP image up to 8 MB.');
  const workerRef = db.collection('workers').doc(workerId);
  const workerSnap = await workerRef.get();
  if (!workerSnap.exists || workerSnap.data().active === false || workerSnap.data().status === 'Inactive') throw new HttpsError('permission-denied', 'Active worker profile required.');
  const submission = await workerRef.collection('workSubmissions').add({
    workerId, workerName: String(workerSnap.data().name || ''), storagePath, note, fileName, contentType, size,
    reviewStatus: 'Submitted', createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { ok: true, submissionId: submission.id };
});

exports.resetWorkerPassword = onCall(async req => {
  if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Admin access required.');
  const workerId = String(req.data?.workerId || '').trim().toUpperCase(); const password = String(req.data?.password || '');
  if (!/^[A-Z0-9_-]{3,32}$/.test(workerId)) throw new HttpsError('invalid-argument', 'Invalid Worker ID.');
  if (password.length < 12 || password.length > 128) throw new HttpsError('invalid-argument', 'Worker password must be 12–128 characters.');
  const ref = db.collection('workers').doc(workerId); const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Worker not found.');
  const credentials = await passwordHash(password); await db.collection('workerCredentials').doc(workerId).set({ salt: credentials.salt, hash: credentials.hash, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.auth.uid });
  return { ok: true, workerId };
});

exports.claimWorkerAccount = onCall(async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Verify your phone first.');
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  const phone = normPhone(req.auth.token.phone_number);
  if (!phone) throw new HttpsError('permission-denied', 'Verified phone number missing.');
  const ref = db.collection('workers').doc(workerId);
  const snap = await ref.get();
  if (!snap.exists || normPhone(snap.data().phone) !== phone) throw new HttpsError('permission-denied', 'Worker ID and verified phone number do not match. Contact admin.');
  if (snap.data().active === false || snap.data().status === 'Inactive') throw new HttpsError('permission-denied', 'This worker account is inactive. Contact admin.');
  const user = await admin.auth().getUser(req.auth.uid);
  await admin.auth().setCustomUserClaims(req.auth.uid, { ...(user.customClaims || {}), workerId });
  await db.collection('users').doc(req.auth.uid).set({ workerId, phone, linkedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, workerId };
});


exports.assignWorkerTask = onCall(async req => {
  if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Admin access required.');
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  const task = String(req.data?.task || '').trim();
  if (!/^[A-Z0-9_-]{3,32}$/.test(workerId)) throw new HttpsError('invalid-argument', 'Invalid Worker ID.');
  if (task.length > 300) throw new HttpsError('invalid-argument', 'Task must be 300 characters or fewer.');
  const ref = db.collection('workers').doc(workerId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Worker not found.');
    tx.update(ref, { task, taskUpdatedAt: admin.firestore.FieldValue.serverTimestamp(), taskUpdatedBy: req.auth.uid });
  });
  return { ok: true, workerId, task };
});


// Admin-only worker profile maintenance. Clients cannot directly edit directory fields.
exports.updateWorkerProfile = onCall(async req => {
  if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Admin access required.');
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  const name = String(req.data?.name || '').trim();
  const phone = normPhone(req.data?.phone);
  if (!/^[A-Z0-9_-]{3,32}$/.test(workerId)) throw new HttpsError('invalid-argument', 'Invalid Worker ID.');
  if (name.length < 2 || name.length > 100) throw new HttpsError('invalid-argument', 'Enter a worker name (2–100 characters).');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new HttpsError('invalid-argument', 'Enter phone in international format, e.g. +91XXXXXXXXXX.');
  const ref = db.collection('workers').doc(workerId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Worker not found.');
    tx.update(ref, { name, phone, profileUpdatedAt: admin.firestore.FieldValue.serverTimestamp(), profileUpdatedBy: req.auth.uid });
  });
  return { ok: true, workerId };
});

exports.setWorkerStatus = onCall(async req => {
  if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Admin access required.');
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  const active = req.data?.active;
  if (!/^[A-Z0-9_-]{3,32}$/.test(workerId) || typeof active !== 'boolean') throw new HttpsError('invalid-argument', 'Worker ID and active status are required.');
  const ref = db.collection('workers').doc(workerId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Worker not found.');
    tx.update(ref, { active, status: active ? 'Active' : 'Inactive', statusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(), statusUpdatedBy: req.auth.uid });
  });
  return { ok: true, workerId, active };
});


// Attendance is written by trusted callable functions instead of allowing the browser
// to mutate worker status and create arbitrary attendance events directly.
async function assertWorkerRequest(req, workerId) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in with the verified worker phone first.');
  const claimedWorkerId = String(req.auth.token.workerId || '').trim().toUpperCase();
  if (!claimedWorkerId || claimedWorkerId !== workerId) throw new HttpsError('permission-denied', 'This signed-in account is not linked to that Worker ID.');
  const ref = db.collection('workers').doc(workerId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Worker profile not found.');
  const worker = snap.data();
  if (worker.active === false || worker.status === 'Inactive') throw new HttpsError('permission-denied', 'This worker account is inactive.');
  if (normPhone(req.auth.token.phone_number) !== normPhone(worker.phone)) throw new HttpsError('permission-denied', 'Verified phone number does not match this worker profile.');
  return { ref, worker };
}

function cleanTask(value) {
  const task = String(value || '').trim();
  if (task.length > 300) throw new HttpsError('invalid-argument', 'Task must be 300 characters or fewer.');
  return task;
}

function optionalCoordinates(data) {
  if (data?.lat == null && data?.lng == null) return {};
  const lat = Number(data.lat), lng = Number(data.lng), accuracy = Number(data.accuracy || 0);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new HttpsError('invalid-argument', 'GPS coordinates are invalid.');
  }
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) {
    throw new HttpsError('invalid-argument', 'GPS accuracy is invalid.');
  }
  return { lat, lng, accuracy };
}

// Worker holiday marking: one request per worker per India-local calendar day.
exports.markWorkerHoliday = onCall({ maxInstances: 20 }, async req => {
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  const reason = String(req.data?.reason || '').trim().slice(0, 200);
  if (!/^[A-Z0-9_-]{3,32}$/.test(workerId)) throw new HttpsError('invalid-argument', 'Invalid Worker ID.');
  const { ref } = await assertWorkerRequest(req, workerId);
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const holidayRef = ref.collection('holidays').doc(dateKey);
  await db.runTransaction(async tx => {
    const [workerSnap, holidaySnap] = await Promise.all([tx.get(ref), tx.get(holidayRef)]);
    if (!workerSnap.exists) throw new HttpsError('not-found', 'Worker profile not found.');
    if (workerSnap.data().status === 'On duty') throw new HttpsError('failed-precondition', 'You are already on duty. Check out before marking a holiday.');
    if (holidaySnap.exists) throw new HttpsError('already-exists', 'Holiday is already marked for today. Contact admin if it needs correction.');
    tx.set(holidayRef, { workerId, date: dateKey, reason, markedAt: admin.firestore.FieldValue.serverTimestamp(), markedBy: req.auth.uid });
    tx.update(ref, { todayHolidayDate: dateKey, todayHolidayMarked: true, todayHolidayMarkedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { ok: true, workerId, date: dateKey };
});

exports.recordWorkerCheckIn = onCall({ maxInstances: 20 }, async req => {
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(workerId)) throw new HttpsError('invalid-argument', 'Invalid Worker ID.');
  const task = cleanTask(req.data?.task);
  const coords = optionalCoordinates(req.data || {});
  if (typeof coords.lat !== 'number' || typeof coords.lng !== 'number') throw new HttpsError('failed-precondition', 'A valid GPS fix is required before check-in.');
  const { ref } = await assertWorkerRequest(req, workerId);
  const eventRef = ref.collection('attendance').doc();
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const holidayRef = ref.collection('holidays').doc(dateKey);
  await db.runTransaction(async tx => {
    const [snap, holidaySnap] = await Promise.all([tx.get(ref), tx.get(holidayRef)]);
    if (!snap.exists) throw new HttpsError('not-found', 'Worker profile not found.');
    const current = snap.data();
    if (current.active === false || current.status === 'Inactive') throw new HttpsError('permission-denied', 'This worker account is inactive.');
    if (holidaySnap.exists) throw new HttpsError('failed-precondition', 'Holiday is already marked for today; contact admin if this needs correction.');
    if (current.status === 'On duty') throw new HttpsError('failed-precondition', 'This worker is already checked in.');
    tx.update(ref, { status: 'On duty', task, checkInAt: admin.firestore.FieldValue.serverTimestamp(), phoneVerified: true });
    tx.set(eventRef, { type: 'check-in', task, timestamp: admin.firestore.FieldValue.serverTimestamp(), ...coords, recordedBy: 'trusted-callable' });
  });
  return { ok: true, workerId, eventId: eventRef.id };
});

exports.recordWorkerCheckOut = onCall({ maxInstances: 20 }, async req => {
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(workerId)) throw new HttpsError('invalid-argument', 'Invalid Worker ID.');
  const task = cleanTask(req.data?.task);
  const coords = optionalCoordinates(req.data || {});
  const { ref } = await assertWorkerRequest(req, workerId);
  const eventRef = ref.collection('attendance').doc();
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Worker profile not found.');
    const current = snap.data();
    if (current.active === false || current.status === 'Inactive') throw new HttpsError('permission-denied', 'This worker account is inactive.');
    if (current.status !== 'On duty') throw new HttpsError('failed-precondition', 'No active duty session was found.');
    tx.update(ref, { status: 'Checked out', task, checkOutAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(eventRef, { type: 'check-out', task, timestamp: admin.firestore.FieldValue.serverTimestamp(), ...coords, recordedBy: 'trusted-callable' });
  });
  return { ok: true, workerId, eventId: eventRef.id };
});


// Native Android GPS queue upload. The stable point ID makes retries idempotent while
// keeping location updates behind authenticated server-side worker validation.
exports.recordWorkerLocation = onCall({ maxInstances: 30 }, async req => {
  const workerId = String(req.data?.workerId || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(workerId)) throw new HttpsError('invalid-argument', 'Invalid Worker ID.');
  const { ref } = await assertWorkerRequest(req, workerId);
  const lat = Number(req.data?.lat), lng = Number(req.data?.lng);
  const accuracy = Number(req.data?.accuracy || 0);
  const queueId = Number(req.data?.queueId);
  const capturedAt = Number(req.data?.capturedAt);
  const task = cleanTask(req.data?.task);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new HttpsError('invalid-argument', 'GPS coordinates are invalid.');
  }
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) throw new HttpsError('invalid-argument', 'GPS accuracy is invalid.');
  if (!Number.isSafeInteger(queueId) || queueId < 1) throw new HttpsError('invalid-argument', 'Native queue ID is invalid.');
  if (!Number.isFinite(capturedAt) || capturedAt < 1 || capturedAt > Date.now() + 5 * 60 * 1000) {
    throw new HttpsError('invalid-argument', 'GPS capture time is invalid.');
  }
  const pointId = `native-${queueId}`;
  const pointRef = ref.collection('locations').doc(pointId);
  await pointRef.set({
    lat, lng, accuracy, task, timestamp: new Date(capturedAt),
    source: 'android-foreground-service', nativeQueueId: queueId,
    serverReceivedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true, workerId, pointId };
});
