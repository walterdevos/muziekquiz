# Installing Muziekquiz on aaPanel

This guide takes a fresh aaPanel server to a running quiz on your own domain
with HTTPS. It assumes aaPanel 7.x with Nginx as the web server. Menu names
below are the English ones in the aaPanel interface.

What you end up with:

- Node.js installed through aaPanel's App Store
- the quiz running as an aaPanel **Node project**, kept alive by PM2 and
  restarted on reboot
- Nginx in front of it on port 443, forwarding the WebSocket connection
- a Let's Encrypt certificate, so players connect over `https://` and `wss://`

## 1. Prerequisites

- A domain or subdomain (for example `quiz.example.com`) with an A record
  pointing at the server's public IP. Wait until it resolves before step 6.
- aaPanel installed with **Nginx** chosen as web server.
- Ports 80 and 443 open in aaPanel (Security menu) and in any cloud firewall.
  Port 3000 does **not** need to be opened; Nginx talks to it locally.

## 2. Install Node.js

1. In aaPanel go to **App Store**.
2. Search for **Node.js Version Manager** and click **Install**.
3. Open it after installation, pick **v22** (or any version 20.6 or newer; the
   start script uses `--env-file`, which needs at least 20.6) and click
   **Install**, then set it as the default version.

The **PM2 Manager** app is installed automatically as a dependency when you
create a Node project in step 4. If it is not, install it from the App Store too.

## 3. Put the code on the server

Pick one of the two methods.

**Method A: git clone (recommended, easy to update later)**

1. Open **Terminal** in the aaPanel sidebar (or SSH in).
2. Run:

   ```bash
   cd /www/wwwroot
   git clone https://github.com/walterdevos/muziekquiz.git
   cd muziekquiz
   npm install --omit=dev
   cp .env.example .env
   ```

   If `git` is missing, install it first with `apt install git` or
   `yum install git`.

**Method B: upload a zip**

1. On your computer, zip the project **without** the `node_modules` folder.
2. In aaPanel open **Files**, go to `/www/wwwroot`, click **Upload** and
   upload the zip, then right-click it and choose **Unzip**. Rename the
   folder to `muziekquiz` if needed.
3. Open **Terminal** and run:

   ```bash
   cd /www/wwwroot/muziekquiz
   npm install --omit=dev
   cp .env.example .env
   ```

Either way, finish by setting ownership so the panel user can read it:

```bash
chown -R www:www /www/wwwroot/muziekquiz
```

## 4. Set the PIN and port

Open **Files**, go to `/www/wwwroot/muziekquiz`, and edit `.env`:

```
PORT=3000
HOST_PIN=4321
ITUNES_COUNTRY=NL
```

- `HOST_PIN` is what the quizmaster types on the `/host` page. Change it.
- `PORT` only matters between Nginx and Node on the same machine. Keep 3000
  unless something else already uses it.
- `ITUNES_COUNTRY` is the iTunes storefront used for searches (`NL`, `BE`,
  `US`, ...). It affects which songs have previews.

`.env` is listed in `.gitignore`, so a later `git pull` will not overwrite it.

## 5. Create the Node project

1. Go to **Website** and open the **Node project** tab.
2. Click **Add Node project** and fill in:

   | Field              | Value                                           |
   |--------------------|-------------------------------------------------|
   | Project directory  | `/www/wwwroot/muziekquiz`                       |
   | Project name       | `muziekquiz`                                    |
   | Startup option     | choose the `start:env` script from package.json |
   | Node version       | the version installed in step 2                 |
   | Port               | `3000` (must match `PORT` in `.env`)            |
   | Run user           | `www`                                           |
   | Domain name        | `quiz.example.com`                              |
   | Project description| optional                                        |

   If your aaPanel version offers a **Run command** field instead of a
   startup option, enter:

   ```
   node --env-file=.env server.js
   ```

3. Click **Confirm**. aaPanel installs PM2 if needed, starts the project and
   writes an Nginx site that proxies the domain to port 3000.

4. Check the **Log** tab of the project. You should see:

   ```
   Muziekquiz listening on http://0.0.0.0:3000
     player page : http://localhost:3000/
     host page   : http://localhost:3000/host   (PIN: ****)
   ```

If the status stays red, the most common cause is that the Node version is
older than 20.6 (the `--env-file` flag is unknown). Install a newer version in
Node.js Version Manager and change the project's Node version.

## 6. Make sure WebSockets are forwarded

Open the project's settings, go to **Config** (the Nginx configuration file),
and look at the `location /` block. It must contain these three lines, which
upgrade the connection for the `/ws` endpoint:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

Recent aaPanel versions add them automatically. If they are missing, add them
inside the `location /` block, and add this line as well so idle connections
are not cut off after 60 seconds:

```nginx
proxy_read_timeout 3600s;
```

Save the file. aaPanel reloads Nginx for you.

Quick test from the Terminal:

```bash
curl -s http://quiz.example.com/healthz
```

The answer should look like `{"ok":true,"serverTime":1795179384109}`.

## 7. Enable HTTPS

1. In the Node project list, click the project and open the **SSL** tab.
2. Choose **Let's Encrypt**, tick the domain, and click **Apply**.
3. Turn on **Force HTTPS**.

HTTPS is not optional for this app. Mobile browsers only allow the Web Audio
features used for sample-accurate playback on secure pages, and the player page
automatically uses `wss://` when it is served over `https://`.

## 8. Try it

- Open `https://quiz.example.com/host`, enter the PIN from `.env`, search for a
  song and press **Select**.
- Open `https://quiz.example.com/` on a phone or second computer and tap
  **Join the quiz**. The host page should show "players connected: 1" and,
  a second later, "clip loaded 1/1".
- Press **Start for everyone**.

## Updating to a new version

```bash
cd /www/wwwroot/muziekquiz
git pull
npm install --omit=dev
```

Then restart the project from **Website > Node project** (the restart icon),
or from Terminal with `pm2 restart muziekquiz`. Your `.env` is kept.

## Troubleshooting

| Symptom                                              | Likely cause and fix                                                                                   |
|------------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| Page loads, header stays red "reconnecting…"         | WebSocket not forwarded. Check the three `Upgrade` lines in step 6. Also confirm the site is on HTTPS.  |
| Project status red, log says `bad option: --env-file`| Node older than 20.6. Install a newer version and select it in the project settings.                    |
| `EADDRINUSE` in the log                              | Another process uses the port. Change `PORT` in `.env` **and** the port in the project settings.         |
| Search returns "Search failed"                       | The server cannot reach `itunes.apple.com`. Check outgoing internet access from the server.               |
| Players connect but hear nothing                     | They must tap **Join** (browser autoplay rule). Check device volume and the **Test sound** button.        |
| Wrong PIN although `.env` is right                   | The project was started before `.env` was edited. Restart the project.                                   |
| Everything works on `http://` but not on `https://`  | Certificate not applied or Force HTTPS pointing at the wrong site. Re-check step 7.                        |

## Notes

- The quiz state is kept in memory. Restarting the project ends the current
  round; open pages reconnect by themselves.
- One server instance hosts one quiz room.
- Keep port 3000 closed in the firewall. Everything should go through Nginx on
  443.
