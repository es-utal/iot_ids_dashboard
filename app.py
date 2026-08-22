"""
IoT Intrusion Detection System — Dashboard Backend
====================================================
Flask API that serves a static dashboard and exposes two endpoints:

  1. POST /api/batch_predict   — bulk-score an uploaded .csv/.parquet file
  2. /api/stream/*              — "live traffic simulation" endpoints that
                                   sample one row at a time from an uploaded
                                   file and score it, for the frontend's
                                   polling loop.

The trained XGBoost model is loaded once at startup from model/model.json
and is forced onto {"device": "cpu"} so it runs on free-tier hosting that
has no GPU.
"""

import io
import os
import time
import uuid

import numpy as np
import pandas as pd
import xgboost as xgb
from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

# ------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "model", "model.json")

# Alphabetical order — must match the label encoding used at training time.
CLASS_NAMES = ["Benign", "DDoS", "DoS", "Mirai", "Other", "Recon"]

# Columns that are metadata/labels rather than model features. Anything
# in this set is dropped before inference if present in the uploaded file.
DROP_COLUMNS = {
    "label", "Label", "LABEL", "class", "Class", "attack", "Attack",
    "time", "Time", "timestamp", "Timestamp", "Unnamed: 0", "index",
}

MAX_CONTENT_LENGTH = 150 * 1024 * 1024  # 150 MB upload cap
STREAM_TTL_SECONDS = 60 * 60             # forget idle stream sessions after 1h
BATCH_PREVIEW_ROWS = 300                 # rows sent back to the frontend table
EXPLAIN_TOP_N = 5                        # top contributing features returned per prediction

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

# ------------------------------------------------------------------
# Load model once at startup (CPU-only — safe for free hosting tiers)
# ------------------------------------------------------------------
print(f"Loading XGBoost model from {MODEL_PATH} ...")
booster = xgb.Booster()
booster.load_model(MODEL_PATH)
booster.set_param({"device": "cpu", "predictor": "cpu_predictor"})
MODEL_FEATURES = booster.feature_names  # None if the model wasn't trained with named columns
print(f"Model loaded. Expected feature count: {len(MODEL_FEATURES) if MODEL_FEATURES else 'unknown (positional)'}")

# In-memory store backing the "Live Attack Simulation" tab.
# {session_id: {"df": DataFrame, "last_seen": epoch_seconds}}
STREAM_STORE = {}


def _cleanup_stream_store():
    now = time.time()
    dead = [sid for sid, v in STREAM_STORE.items() if now - v["last_seen"] > STREAM_TTL_SECONDS]
    for sid in dead:
        STREAM_STORE.pop(sid, None)


def load_dataframe(file_storage) -> pd.DataFrame:
    """Read an uploaded .csv or .parquet file into a DataFrame without touching disk."""
    filename = secure_filename(file_storage.filename or "")
    if not filename:
        raise ValueError("Empty filename.")

    raw = file_storage.read()
    buf = io.BytesIO(raw)

    if filename.lower().endswith(".parquet"):
        df = pd.read_parquet(buf)
    elif filename.lower().endswith(".csv"):
        df = pd.read_csv(buf)
    else:
        raise ValueError("Unsupported file type — please upload a .csv or .parquet file.")

    return df


def prepare_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Reproduce the training-time preprocessing closely enough for inference:
      - drop label/time/metadata columns if present
      - keep numeric columns only
      - align to the exact feature set/order the model was trained on
      - replace inf/NaN with 0 (matches how missing values were handled upstream)
    """
    df = df.copy()
    df = df.drop(columns=[c for c in df.columns if c in DROP_COLUMNS], errors="ignore")
    df = df.select_dtypes(include=[np.number, "bool"])

    if MODEL_FEATURES:
        for col in MODEL_FEATURES:
            if col not in df.columns:
                df[col] = 0.0
        df = df[MODEL_FEATURES]

    df = df.replace([np.inf, -np.inf], np.nan).fillna(0)
    return df


def predict_dataframe(df: pd.DataFrame):
    features = prepare_features(df)
    dmatrix = xgb.DMatrix(features, feature_names=list(features.columns))
    probs = booster.predict(dmatrix)
    preds = np.argmax(probs, axis=1)
    confidences = np.max(probs, axis=1)
    return preds, confidences, probs, features


def compute_feature_contributions(features: pd.DataFrame, preds: np.ndarray, top_n: int = EXPLAIN_TOP_N):
    """
    Native TreeSHAP explanation for each row, using the exact same booster
    that produced the prediction (xgb.Booster.predict(..., pred_contribs=True)).
    Returns, per row, the top_n features whose SHAP contribution to the
    *predicted* class's margin had the largest magnitude — i.e. the features
    that most drove this specific verdict.
    """
    dmatrix = xgb.DMatrix(features, feature_names=list(features.columns))
    contribs = np.asarray(booster.predict(dmatrix, pred_contribs=True))

    n = len(preds)
    feature_names = list(features.columns)
    feature_matrix = features.to_numpy()

    if contribs.ndim == 3:
        # multiclass: (n_rows, n_classes, n_features + 1) — last column is the bias term.
        row_contribs = contribs[np.arange(n), preds, :-1]
    else:
        # binary/regression fallback: (n_rows, n_features + 1)
        row_contribs = contribs[:, :-1]

    explanations = []
    for i in range(n):
        c = row_contribs[i]
        vals = feature_matrix[i]
        order = np.argsort(-np.abs(c))[:top_n]
        explanations.append([
            {
                "feature": feature_names[j],
                "value": round(float(vals[j]), 6),
                "contribution": round(float(c[j]), 6),
                "direction": "increased" if c[j] > 0 else "decreased",
            }
            for j in order
        ])
    return explanations


# ------------------------------------------------------------------
# Static frontend
# ------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "classes": CLASS_NAMES,
        "num_features_expected": len(MODEL_FEATURES) if MODEL_FEATURES else None,
    })


# ------------------------------------------------------------------
# 1. Batch Analysis
# ------------------------------------------------------------------
@app.route("/api/batch_predict", methods=["POST"])
def batch_predict():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded. Use form field 'file'."}), 400

    file_storage = request.files["file"]
    if file_storage.filename == "":
        return jsonify({"error": "No file selected."}), 400

    try:
        df = load_dataframe(file_storage)
    except Exception as e:
        return jsonify({"error": f"Failed to read file: {e}"}), 400

    if df.empty:
        return jsonify({"error": "Uploaded file has no rows."}), 400

    try:
        preds, confidences, probs, features = predict_dataframe(df)
    except Exception as e:
        return jsonify({"error": f"Prediction failed: {e}"}), 500

    pred_labels = [CLASS_NAMES[p] for p in preds]
    total = len(pred_labels)

    summary = {name: 0 for name in CLASS_NAMES}
    for label in pred_labels:
        summary[label] += 1

    attack_count = total - summary["Benign"]

    preview_n = min(BATCH_PREVIEW_ROWS, total)
    preview_features = features.iloc[:preview_n].reset_index(drop=True)
    preview_preds = preds[:preview_n]

    try:
        explanations = compute_feature_contributions(preview_features, preview_preds)
    except Exception:
        explanations = [[] for _ in range(preview_n)]

    preview_rows = [
        {
            "row": i,
            "prediction": pred_labels[i],
            "confidence": round(float(confidences[i]), 4),
            "top_features": explanations[i],
        }
        for i in range(preview_n)
    ]

    return jsonify({
        "total_rows": total,
        "summary": summary,
        "attack_count": int(attack_count),
        "benign_count": int(summary["Benign"]),
        "attack_ratio": round(attack_count / total, 4) if total else 0.0,
        "preview": preview_rows,
        "preview_truncated": total > preview_n,
    })


# ------------------------------------------------------------------
# 2. Live Attack Simulation
# ------------------------------------------------------------------
@app.route("/api/stream/upload", methods=["POST"])
def stream_upload():
    _cleanup_stream_store()

    if "file" not in request.files:
        return jsonify({"error": "No file uploaded. Use form field 'file'."}), 400

    file_storage = request.files["file"]
    if file_storage.filename == "":
        return jsonify({"error": "No file selected."}), 400

    try:
        df = load_dataframe(file_storage)
    except Exception as e:
        return jsonify({"error": f"Failed to read file: {e}"}), 400

    if df.empty:
        return jsonify({"error": "Uploaded file has no rows."}), 400

    session_id = str(uuid.uuid4())
    STREAM_STORE[session_id] = {"df": df.reset_index(drop=True), "last_seen": time.time()}

    return jsonify({"session_id": session_id, "total_rows": len(df)})


@app.route("/api/stream/next", methods=["GET"])
def stream_next():
    session_id = request.args.get("session_id", "")
    entry = STREAM_STORE.get(session_id)
    if entry is None:
        return jsonify({"error": "Invalid or expired session_id. Upload a stream file first."}), 400

    entry["last_seen"] = time.time()
    df = entry["df"]
    row_idx = int(np.random.randint(0, len(df)))
    row_df = df.iloc[[row_idx]]

    try:
        preds, confidences, _, features = predict_dataframe(row_df)
        top_features = compute_feature_contributions(features, preds)[0]
    except Exception as e:
        return jsonify({"error": f"Prediction failed: {e}"}), 500

    label = CLASS_NAMES[preds[0]]
    return jsonify({
        "row_index": row_idx,
        "prediction": label,
        "confidence": round(float(confidences[0]), 4),
        "is_attack": label != "Benign",
        "time": time.strftime("%H:%M:%S"),
        "top_features": top_features,
    })


@app.route("/api/stream/reset", methods=["POST"])
def stream_reset():
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id", "")
    STREAM_STORE.pop(session_id, None)
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
