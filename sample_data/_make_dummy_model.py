"""Dev-only helper: creates a throwaway model.json + sample CSVs so the
dashboard can be smoke-tested before the real trained model is dropped in.
Not part of the deployed app — safe to delete.
"""
import numpy as np
import pandas as pd
import xgboost as xgb

rng = np.random.default_rng(42)
FEATURES = [f"feat_{i}" for i in range(10)]
CLASSES = ["Benign", "DDoS", "DoS", "Mirai", "Other", "Recon"]

n = 300
X = pd.DataFrame(rng.normal(size=(n, len(FEATURES))), columns=FEATURES)
y = rng.integers(0, len(CLASSES), size=n)

dtrain = xgb.DMatrix(X, label=y, feature_names=FEATURES)
params = {"objective": "multi:softprob", "num_class": len(CLASSES), "tree_method": "hist", "device": "cpu"}
bst = xgb.train(params, dtrain, num_boost_round=10)
bst.save_model("model/model.json")

# Sample file WITH a label column (mimics a raw test parquet/csv)
df_with_label = X.copy()
df_with_label["label"] = y
df_with_label.to_csv("sample_data/sample_with_label.csv", index=False)

# Sample file for the live stream (no label needed)
X.to_csv("sample_data/sample_stream.csv", index=False)

print("Dummy model + sample CSVs written.")
