from fastapi import FastAPI
from openai import OpenAI
from pydantic import BaseModel
import uvicorn
import os
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("API_KEY")
BASE_URL = os.getenv("API_BASE_URL")
MODEL_NAME = os.getenv("MODEL_NAME")

client = OpenAI(api_key=API_KEY, base_url=BASE_URL)
app = FastAPI()


class DiagnosticData(BaseModel):
    code_context: str
    diagnostic_message: str


def query_llm(messages):
    completion = client.chat.completions.create(
        model=MODEL_NAME,
        messages=messages,
        response_format={"type": "text"},
        timeout=30,
    )
    return completion.choices[0].message.content


@app.get("/")
async def root():
    return {"message": "owo"}


@app.post("/analyze")
async def analyze_error(data: DiagnosticData):
    messages = [
        {
            "role": "system",
            "content": "You are a helpful coding tutor. Provide a brief one-sentence hint to fix the following error. DO NOT fix the code directly.",
        },
        {
            "role": "user",
            "content": f"Error: {data.code_context}\n\nCode context:\n{data.diagnostic_message}",
        },
    ]
    response = query_llm(messages)
    return {"hint": response}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
