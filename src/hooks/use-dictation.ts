// Dictée vocale : enregistrement micro (MediaRecorder) puis transcription
// via l'événement socket `audio:transcribe` du mini-service (ASR).
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseDictationOptions {
  onTranscript: (text: string) => void;
  transcribe: (dataBase64: string) => Promise<string>;
}

const MAX_RECORDING_MS = 60_000;

export function useDictation({ onTranscript, transcribe }: UseDictationOptions) {
  const [supported, setSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // Revue 2026-11-19, 4.7 (C) : drapeau SYNCHRONE — `streamRef` n'est
  // affecté qu'après l'await getUserMedia ; sans lui, deux clics rapprochés
  // passaient tous deux la garde pendant la fenêtre asynchrone.
  const startingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const transcribeRef = useRef(transcribe);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    transcribeRef.current = transcribe;
  }, [onTranscript, transcribe]);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        typeof navigator !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof window.MediaRecorder !== "undefined"
    );
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    startingRef.current = false; // 4.7 : prêt pour un nouvel enregistrement
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    // Revue 2026-11-19, 4.7 (C) : garde réentrante — un double-clic avant le
    // re-rendu du bouton appelait getUserMedia deux fois ; le second flux
    // écrasait streamRef sans arrêter les pistes du premier (indicateur micro
    // du navigateur coincé, flux fantôme jusqu'à la fin du second tour).
    if (startingRef.current || recorderRef.current || streamRef.current) return;
    startingRef.current = true;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        cleanup();
        if (blob.size < 512) {
          setProcessing(false);
          return; // trop court — ignoré
        }
        setProcessing(true);
        try {
          const dataBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = String(reader.result ?? "");
              resolve(result.includes(",") ? result.split(",")[1] : result);
            };
            reader.onerror = () => reject(new Error("Lecture de l'audio impossible"));
            reader.readAsDataURL(blob);
          });
          const text = await transcribeRef.current(dataBase64);
          if (text) onTranscriptRef.current(text);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Échec de la transcription");
          setTimeout(() => setError(null), 4000);
        } finally {
          setProcessing(false);
          setSeconds(0);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setSeconds(0);
      const startedAt = Date.now();
      timerRef.current = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        setSeconds(s);
        if (Date.now() - startedAt >= MAX_RECORDING_MS) stop();
      }, 500);
    } catch {
      setError("Micro indisponible ou refusé");
      setTimeout(() => setError(null), 4000);
      cleanup(); // relâche aussi startingRef (4.7)
      setRecording(false);
    }
  }, [cleanup, stop]);

  return { supported, recording, processing, seconds, error, start, stop };
}
