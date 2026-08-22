# IoT-IDS Dashboard

A self-contained Flask + vanilla-JS dashboard for demoing a trained XGBoost
IoT intrusion-detection model: batch file scoring and a live traffic
simulation, styled as a dark security console.

## 1. Project layout

```
iot-ids-dashboard/
├── app.py                 # Flask backend (loads model, serves API + UI)
├── requirements.txt
├── Procfile                # gunicorn start command for hosting platforms
├── .gitignore
├── model/
│   └── model.json          # <-- put your trained XGBoost model here
├── templates/
│   └── index.html          # dashboard markup
├── static/
│   ├── style.css           # dark theme
│   └── script.js           # tab logic, uploads, polling, rendering
└── sample_data/             # (empty) drop a small CSV here for local testing
```

## 2. Put your model in place

Copy your trained model file into `model/model.json` (the exact filename
`app.py` expects). This is the file produced by `booster.save_model(...)`
in your training script (e.g. `global_model.json`) — just rename/copy it.

The backend loads it once at startup and forces `{"device": "cpu"}` so it
runs safely without a GPU:

```python
booster = xgb.Booster()
booster.load_model(MODEL_PATH)
booster.set_param({"device": "cpu", "predictor": "cpu_predictor"})
```

If the booster has stored feature names (true when you trained via
`xgb.DMatrix(dataframe, label=...)` with a named DataFrame, as your script
does), the backend automatically reindexes every uploaded file to match
those exact columns/order — missing columns are filled with `0`, extra
columns are dropped. Label/time-like columns (`label`, `time`,
`timestamp`, `Unnamed: 0`, etc.) are stripped automatically before that.

**Important:** this reproduces the *shape* of your preprocessing (numeric
columns only, aligned to the trained feature set, NaN/inf → 0) but not any
custom scaling/encoding steps from your original pipeline. If your
training pipeline applied additional transforms (scaling, log transforms,
categorical encoding) before building the DMatrix, add that logic to
`prepare_features()` in `app.py` so uploaded files get the same treatment.

## 3. Run it locally

```bash
cd iot-ids-dashboard
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux
pip install -r requirements.txt
python app.py
```

Visit **http://localhost:5000**.

- **Batch Analysis tab** — upload a `.csv`/`.parquet` slice of your test
  data (with or without the label column, it's dropped automatically) and
  click *Analyze Traffic*.
- **Live Simulation tab** — upload a `.csv` to act as the traffic stream,
  then *Start Stream*; the frontend polls `/api/stream/next` every
  1–2 seconds (configurable) and appends a flashing row (green = Benign,
  red = attack) to the live log.

## 4. Deploy for free — Render.com

Render's free web-service tier is the most Flask-friendly free option
(native Python buildpack, no WSGI-file wrangling like PythonAnywhere,
supports file uploads and long-lived processes). Steps:

### 4.1 Push the project to GitHub

```bash
cd iot-ids-dashboard
git init
git add .
git commit -m "Initial IoT-IDS dashboard"
```

Create a new empty repo on GitHub (e.g. `iot-ids-dashboard`), then:

```bash
git remote add origin https://github.com/<your-username>/iot-ids-dashboard.git
git branch -M main
git push -u origin main
```

> Your `model.json` will be committed too (that's fine — Render pulls the
> repo to build the app). If the model file is large (>50–100 MB), use
> [Git LFS](https://git-lfs.com/) instead of committing it raw, or upload
> it to Render as a manual file via their dashboard's disk feature.

### 4.2 Create the Render service

1. Sign up / log in at **https://render.com** (free, no credit card
   required for the free tier).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account and select the `iot-ids-dashboard` repo.
4. Fill in the settings:
   - **Name**: `iot-ids-dashboard` (or anything)
   - **Region**: closest to you
   - **Branch**: `main`
   - **Root Directory**: leave blank if `app.py` is at the repo root
   - **Runtime**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 4 --timeout 120`
     (Render also auto-detects the included `Procfile`, so you can leave
     the start command blank and it will use that.)
   - **Instance Type**: **Free**
5. Click **Create Web Service**. Render will build and deploy — first
   build takes a few minutes (installing xgboost/pandas/pyarrow).
6. Once live, Render gives you a URL like
   `https://iot-ids-dashboard.onrender.com` — open it, you'll see the
   dashboard.

### 4.3 Free-tier notes

- The free instance has **512 MB RAM** and **spins down after ~15 minutes
  of inactivity**; the next request triggers a cold start (~30–60s while
  it wakes up and reloads the model). This is expected and fine for a
  research demo.
- Keep uploaded files reasonably sized (a few thousand rows) — pandas +
  xgboost inference on the free tier's limited RAM/CPU is fine for demo
  volumes but not for multi-GB captures.
- The app runs with **`--workers 1`** intentionally: the live-simulation
  session store (`STREAM_STORE`) lives in the process's memory, and
  multiple gunicorn workers wouldn't share it. `--threads 4` still lets it
  handle several concurrent requests.
- No database, Redis, or persistent disk is required — everything needed
  (the model + in-memory session store) lives in the single web process.

### 4.4 Alternative free hosts

- **Railway.app** (free trial credits, not permanently free) — same
  steps as Render: connect repo, it detects the `Procfile` automatically.
- **PythonAnywhere** (free tier) — works, but requires manually editing a
  WSGI config file to point at `app.py`'s `app` object instead of using a
  `Procfile`/gunicorn, and free accounts can only make outbound requests
  to an allow-listed set of domains (not relevant here since everything
  is self-contained). Render is simpler for this project.
- **Fly.io** — free allowance is small and requires a Dockerfile; more
  setup than Render for the same result.

Render.com is the recommended path above because it needs zero extra
config beyond the `Procfile` already included.

## 5. API reference (for reference / testing with curl)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Model status + expected feature count |
| `/api/batch_predict` | POST (`multipart/form-data`, field `file`) | Score a full CSV/Parquet file, return class summary + preview rows |
| `/api/stream/upload` | POST (`multipart/form-data`, field `file`) | Register a CSV as the live-simulation source, returns `session_id` |
| `/api/stream/next?session_id=...` | GET | Predict one random row from the registered stream |
| `/api/stream/reset` | POST (JSON `{"session_id": "..."}`) | Drop a stream session from memory |
