// Replace these values with your Firebase Web App config before deployment.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  appId: "YOUR_APP_ID"
};
export const FIREBASE_READY = !Object.values(firebaseConfig).some(v => String(v).startsWith('YOUR_'));
