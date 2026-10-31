# Setting up the 3 new addons (from your phone)

You will repeat the same steps 3 times, once per addon.

| Addon          | File to upload     | Render Start Command       | Rows |
|----------------|--------------------|----------------------------|------|
| OriginalsVault | originalsvault.js  | node originalsvault.js     | 37   |
| StudioVault    | studiovault.js     | node studiovault.js        | 41   |
| NetworkVault   | networkvault.js    | node networkvault.js       | 39   |

Every repo also gets the same small file: package.json

## A. GitHub (one new repo per addon)
1. In your browser open github.com and sign in. Tap the + icon, then New repository.
2. Name it exactly like the addon (for example originalsvault). Leave everything else as is. Tap Create repository.
3. On the new repo page tap "uploading an existing file" (or Add file, then Upload files).
4. Pick TWO files: the addon file (for example originalsvault.js) and package.json.
5. Tap Commit changes.

## B. Render (one new Web Service per addon)
1. Open render.com, tap New +, then Web Service.
2. Choose the repo you just made.
3. Fill in:
   - Name: the addon name in lower case (this becomes the web address)
   - Language / Runtime: Node
   - Build Command: npm install
   - Start Command: the one from the table above (for example: node originalsvault.js)
   - Instance Type: Free
4. Open Environment, tap Add Environment Variable:
   - Key: TMDB_KEY
   - Value: your TMDB API key (same one your other addons use; copy it from their Environment tab)
5. Tap Create Web Service and wait until it says Live (a few minutes).

## C. Check it before installing
Open  https://YOUR-NAME.onrender.com/debug  in your browser (the first open can take up to a minute).
You get a list like:
   OK     1234  series 🔴 Netflix Originals
   EMPTY     0  series 🎬 MGM+ Originals   <- network not found
Send me that page (copy/paste or screenshot). Rows marked EMPTY or THIN I will fix.

## D. Install in Stremio
Open  https://YOUR-NAME.onrender.com/  and tap "Install in Stremio".
If that does not open Stremio: Stremio, Addons, search box, paste
https://YOUR-NAME.onrender.com/manifest.json

Notes
- Free Render sleeps when unused. The first open after a rest is slow, then fast.
- The very first time you open each row it takes a few seconds (it looks up IMDb ids). After that it is cached for 6 hours.
- To update later, I send a new .js file. You upload it to the same repo (Add file, Upload files) and Render redeploys by itself.
