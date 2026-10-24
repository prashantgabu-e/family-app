# Gujarati Family Tree

Private family-tree app built with Vite, React, Firebase Authentication, and Firestore.

Relationships are stored directly between two members. Each connection has an optional free-form label (with Gujarati/English suggestions), rather than separate profile-level relationship labels.

Each branch starts with one primary person and contains that person's connected family: parents, spouse, children, in-laws, and either side of the extended family. Create a new branch only for a separate person's family tree.

## Firebase setup

1. Create a Firebase project and register a Web app.
2. Enable **Authentication → Sign-in method → Google** and add your GitHub Pages domain to **Authentication → Settings → Authorized domains**.
3. Create a Firestore database in production mode.
4. Copy `.env.example` to `.env` and fill in the Web app values. This repository defaults to `/family-app/`; set `VITE_BASE_PATH` to `/<your-repository-name>/` if the repository is renamed (or `/` for a custom domain).
5. Install Firebase CLI, sign in, select the project, then deploy the protection rules: `firebase deploy --only firestore:rules`.
6. Run `npm install`, then `npm run build`. Commit the generated `docs/` folder and configure GitHub Pages to deploy from `main` / `docs`.

Firebase web configuration is intentionally included in the browser bundle. Access is protected by the Firestore rules in `firestore.rules`; do not weaken them.
