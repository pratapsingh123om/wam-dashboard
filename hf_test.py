# hf_test.py -- quick HF token + model test
import os, requests, json, sys

HF = os.environ.get("HF_API_KEY")
print("HF_API_KEY present:", bool(HF))
if HF:
    print("HF token preview:", HF[:6] + "..." + str(len(HF)))
else:
    print("HF_API_KEY not set in THIS shell; start backend from the same shell or set env var and retry.")
    sys.exit(1)

def test_model(model_id, payload_text="Hello"):
    url = f"https://api-inference.huggingface.co/models/{model_id}"
    headers = {"Authorization": f"Bearer {HF}", "Content-Type": "application/json"}
    payload = {"inputs": payload_text, "options": {"wait_for_model": True}}
    print("\n>>> Testing model:", model_id)
    try:
        r = requests.post(url, headers=headers, json=payload, timeout=30)
        print("HTTP", r.status_code)
        # print short preview of body and headers
        print("Response headers preview:", json.dumps(dict(r.headers), indent=2)[:1000])
        print("Response body preview (first 1200 chars):\n", r.text[:1200])
    except Exception as e:
        print("Request error:", repr(e))

if __name__ == "__main__":
    # first test a known public model to check token validity
    test_model("gpt2", "Hello world")
    # then test desired model (only if above passes)
    test_model("google/flan-t5-small", "Summarize: water sample TDS 450, pH 7.0.")
