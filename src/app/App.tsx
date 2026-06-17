import { useState, useRef, useEffect, useCallback } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Upload,
  Clock,
  Crown,
  FileText,
  ChevronDown,
  SkipBack,
  SkipForward,
  Loader2,
  Link,
  X,
  Monitor,
  StopCircle,
} from "lucide-react";

const OPENAI_KEY = (import.meta.env.VITE_OPENAI_API_KEY as string) ?? "";

type VideoStatus = "processing" | "ready" | "uploading";

interface VideoItem {
  id: string;
  title: string;
  status: VideoStatus;
  progress?: number;
  duration: string;
  thumbnail: string;
  language: string;
  src?: string;
}

const SAMPLE_VIDEOS: VideoItem[] = [
  {
    id: "1",
    title: "French Cooking Masterclass",
    status: "ready",
    duration: "28:45",
    thumbnail: "https://images.unsplash.com/photo-1556910103-1c02745aae4d?w=400&h=225&fit=crop&auto=format",
    language: "French",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  },
  {
    id: "2",
    title: "Japanese Business Presentation",
    status: "processing",
    progress: 67,
    duration: "15:30",
    thumbnail: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=400&h=225&fit=crop&auto=format",
    language: "Japanese",
  },
  {
    id: "3",
    title: "Spanish Documentary",
    status: "ready",
    duration: "42:18",
    thumbnail: "https://images.unsplash.com/photo-1485846234645-a62644f84728?w=400&h=225&fit=crop&auto=format",
    language: "Spanish",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
  },
];

export default function App() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showPlaybackMenu, setShowPlaybackMenu] = useState(false);
  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [audioTrack, setAudioTrack] = useState<"original" | "english">("english");
  const [dailyMinutesUsed, setDailyMinutesUsed] = useState(12);
  const [adsWatchedToday, setAdsWatchedToday] = useState(0);
  const [isPro, setIsPro] = useState(false);
  const [videos, setVideos] = useState<VideoItem[]>(SAMPLE_VIDEOS);
  const [activeVideo, setActiveVideo] = useState<VideoItem>(SAMPLE_VIDEOS[0]);
  const [isDragging, setIsDragging] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [playerUrl, setPlayerUrl] = useState("");
  const [showPlayerUrlInput, setShowPlayerUrlInput] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationText, setTranslationText] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const playbackMenuRef = useRef<HTMLDivElement>(null);
  const audioMenuRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const autoPlayRef = useRef(false);
  const screenStreamRef = useRef<MediaStream | null>(null);
  // Stable refs so keyboard handlers never have stale closures
  const togglePlayRef = useRef<() => void>(() => {});
  const skipTimeRef = useRef<(s: number) => void>(() => {});
  // Translation pipeline refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const translationTimerRef = useRef<ReturnType<typeof setInterval>>();
  const stopTranslationRef = useRef<() => void>(() => {});
  // Keep utterance alive — Chrome GCs it before playback if stored only in a local var
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const dailyLimit = 45;
  const remainingMinutes = dailyLimit - dailyMinutesUsed;
  const usagePercentage = (dailyMinutesUsed / dailyLimit) * 100;
  const playbackRates = [0.5, 1, 1.25, 1.5, 2];

  // Load video whenever activeVideo changes — skip if screen capture is active
  useEffect(() => {
    const video = videoRef.current;
    if (!video || screenStreamRef.current) return;
    setVideoError(null);
    setIsBuffering(false);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    clearTimeout(hideTimerRef.current);
    setControlsVisible(true);
    video.src = activeVideo.src ?? "";
    video.load();
  }, [activeVideo.id]);

  // Wire up the screen stream to the video element after state updates settle
  useEffect(() => {
    if (!isCapturing || !videoRef.current || !screenStreamRef.current) return;
    videoRef.current.srcObject = screenStreamRef.current;
    videoRef.current.play().catch(() => {});
  }, [isCapturing]);

  // Sync video volume based on audio track:
  // English mode → duck original to 15% so background music/SFX stays audible
  // Original mode → restore user-set volume
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (audioTrack === "english") {
      video.muted = false;
      video.volume = 0.15;
    } else {
      video.muted = isMuted;
      video.volume = isMuted ? 0 : volume;
    }
  }, [audioTrack, isMuted, volume]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (playbackMenuRef.current && !playbackMenuRef.current.contains(e.target as Node)) {
        setShowPlaybackMenu(false);
      }
      if (audioMenuRef.current && !audioMenuRef.current.contains(e.target as Node)) {
        setShowAudioMenu(false);
      }
    };
    // Use refs so these always call the current version of the function
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") { e.preventDefault(); togglePlayRef.current(); }
      if (e.code === "ArrowLeft") skipTimeRef.current(-10);
      if (e.code === "ArrowRight") skipTimeRef.current(10);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const processAudioChunk = useCallback(async (blob: Blob, key: string) => {
    if (blob.size < 500) return;
    try {
      const formData = new FormData();
      formData.append("file", blob, "audio.webm");
      formData.append("model", "whisper-1");
      formData.append("task", "translate");
      const res = await fetch("https://api.openai.com/v1/audio/translations", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: formData,
      });
      if (!res.ok) {
        if (res.status === 401) setVideoError("Invalid OpenAI API key — check your key in the Audio settings.");
        return;
      }
      const data = await res.json();
      const text = (data.text ?? "").trim();
      if (!text) return;
      setTranslationText(text);
      // Prevent Chrome's ~15s synthesis pause bug
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      window.speechSynthesis.cancel();
      // 100ms gap after cancel — Chrome drops speak() called immediately after cancel()
      setTimeout(() => {
        const utt = new SpeechSynthesisUtterance(text);
        utt.lang = "en-US";
        utt.rate = 1.1;
        utt.volume = 1.0;
        utteranceRef.current = utt;
        window.speechSynthesis.speak(utt);
      }, 100);
    } catch {
      // transient network error — will retry on next chunk
    }
  }, []);

  const stopTranslation = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    clearInterval(translationTimerRef.current);
    window.speechSynthesis?.cancel();
    utteranceRef.current = null;
    setIsTranslating(false);
    setTranslationText("");
  }, []);
  stopTranslationRef.current = stopTranslation;

  const startTranslation = useCallback((key: string) => {
    stopTranslation();

    const video = videoRef.current;

    // --- Step 1: get audio stream ---
    let stream: MediaStream | null = null;
    try {
      stream =
        screenStreamRef.current ??
        (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.() ??
        null;
    } catch {
      // SecurityError: cross-origin video without CORS headers
      setVideoError(
        "Cannot capture audio from this source. Upload a local video file or use Screen Capture mode."
      );
      return;
    }

    if (!stream) {
      setVideoError("Audio capture is not supported in this browser.");
      return;
    }

    // --- Step 2: isolate audio tracks ---
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      setVideoError("No audio track detected in this video.");
      return;
    }

    // --- Step 3: pick best supported mime type ---
    const mimeType =
      ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"].find(
        (m) => MediaRecorder.isTypeSupported(m)
      ) ?? "";

    // --- Step 4: start recorder ---
    try {
      const audioStream = new MediaStream(audioTracks);
      const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onerror = () => setVideoError("Audio recording failed.");

      // 3-second chunks → first translation arrives ~4-6 s after play
      recorder.start(3000);
      setIsTranslating(true);
      setTranslationText("Listening…");

      translationTimerRef.current = setInterval(() => {
        const chunks = audioChunksRef.current.splice(0);
        if (chunks.length === 0) return;
        const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
        processAudioChunk(blob, key);
      }, 3500);
    } catch (e) {
      setVideoError("Could not start audio capture. Try uploading a local file instead.");
    }
  }, [stopTranslation, processAudioChunk]);

  const stopScreenCapture = useCallback(() => {
    stopTranslationRef.current();
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsCapturing(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setControlsVisible(true);
  }, []);

  const handleScreenCapture = async () => {
    try {
      stopScreenCapture();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });
      screenStreamRef.current = stream;

      const captureItem: VideoItem = {
        id: "screen-" + Date.now(),
        title: "Screen Capture",
        status: "ready",
        duration: "Live",
        thumbnail: "",
        language: "Auto-detect",
      };
      setActiveVideo(captureItem);
      setVideoError(null);
      setIsBuffering(false);
      setCurrentTime(0);
      setDuration(0);
      setIsCapturing(true); // triggers the srcObject effect above

      // If user clicks "Stop sharing" in the browser UI
      stream.getTracks().forEach((track) => {
        track.addEventListener("ended", () => stopScreenCapture());
      });
    } catch (err: unknown) {
      const name = (err as DOMException)?.name;
      if (name !== "AbortError" && name !== "NotAllowedError") {
        setVideoError("Screen capture failed. Please try again.");
      }
    }
  };

  const loadVideo = (item: VideoItem) => {
    if (item.status !== "ready") return;
    stopTranslationRef.current();
    if (screenStreamRef.current) stopScreenCapture();
    setActiveVideo(item);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  };

  const addVideoFromFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    autoPlayRef.current = true;
    const newVideo: VideoItem = {
      id: Date.now().toString(),
      title: file.name.replace(/\.[^/.]+$/, ""),
      status: "ready",
      duration: "--:--",
      thumbnail: "",
      language: "Auto-detect",
      src: url,
    };
    setVideos((prev) => [newVideo, ...prev]);
    setActiveVideo(newVideo);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) addVideoFromFile(file);
    e.target.value = "";
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("video/")) addVideoFromFile(file);
  };

  const playFromUrl = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    autoPlayRef.current = true;
    const newVideo: VideoItem = {
      id: Date.now().toString(),
      title: trimmed.split("/").pop()?.replace(/\?.*$/, "") ?? "Imported Video",
      status: "ready",
      duration: "--:--",
      thumbnail: "",
      language: "Auto-detect",
      src: trimmed,
    };
    setVideos((prev) => [newVideo, ...prev]);
    loadVideo(newVideo);
  };

  const handleUrlImport = () => {
    playFromUrl(urlInput);
    setUrlInput("");
    setShowUrlInput(false);
  };

  const handlePlayerUrlPlay = () => {
    playFromUrl(playerUrl);
    setPlayerUrl("");
    setShowPlayerUrlInput(false);
  };

  const revealControls = () => {
    setControlsVisible(true);
    clearTimeout(hideTimerRef.current);
    if (isPlaying) {
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
    }
  };

  const startHideTimer = () => {
    clearTimeout(hideTimerRef.current);
    if (isPlaying) {
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 1000);
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play().catch(() => {});
    }
  };
  togglePlayRef.current = togglePlay;

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      const d = videoRef.current.duration;
      setDuration(d);
      const mins = Math.floor(d / 60);
      const secs = Math.floor(d % 60);
      const fmt = `${mins}:${secs.toString().padStart(2, "0")}`;
      setActiveVideo((prev) => {
        if (prev.duration === "--:--") {
          setVideos((vs) => vs.map((v) => (v.id === prev.id ? { ...v, duration: fmt } : v)));
          return { ...prev, duration: fmt };
        }
        return prev;
      });
    }
  };

  const handleEnded = () => {
    stopTranslationRef.current();
    setIsPlaying(false);
    setCurrentTime(0);
    setControlsVisible(true);
    clearTimeout(hideTimerRef.current);
    if (videoRef.current) videoRef.current.currentTime = 0;
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (videoRef.current) videoRef.current.currentTime = time;
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseFloat(e.target.value);
    setVolume(vol);
    setIsMuted(vol === 0);
    // audioTrack useEffect syncs video.volume; direct set here only for instant response in original mode
    if (audioTrack === "original" && videoRef.current) {
      videoRef.current.volume = vol;
      videoRef.current.muted = vol === 0;
    }
  };

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    // In English mode: muting silences both TTS and the ducked original
    if (audioTrack === "english" && next) window.speechSynthesis?.cancel();
    // volume/muted on the video element is synced by the audioTrack useEffect
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      playerRef.current?.requestFullscreen();
    }
  };

  const setSpeed = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
    setShowPlaybackMenu(false);
  };

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const skipTime = (seconds: number) => {
    if (videoRef.current) {
      const next = Math.max(0, Math.min(duration, currentTime + seconds));
      videoRef.current.currentTime = next;
      setCurrentTime(next);
    }
  };
  skipTimeRef.current = skipTime;

  const watchAd = () => {
    if (adsWatchedToday >= 3) return;
    setAdsWatchedToday((n) => n + 1);
    setDailyMinutesUsed((n) => Math.max(0, n - 15));
  };

  const selectAudioTrack = (track: "english" | "original") => {
    setAudioTrack(track);
    setShowAudioMenu(false);
    if (track === "english") {
      if (isPlaying) startTranslation(OPENAI_KEY);
    } else {
      stopTranslation();
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <svg
              width="180"
              height="65"
              viewBox="0 0 319.61 131.19"
              className="h-14"
              xmlns="http://www.w3.org/2000/svg"
            >
              <g>
                <path fill="#231F20" d="M0,126.99v-14.15h8.87v1.84H2.13v4.31h6.28v1.83H2.13v4.33h6.82v1.84H0z"/>
                <path fill="#231F20" d="M20.26,116.38l-3.85,10.62H14.2l-3.86-10.62h2.22l2.69,8.17h0.11l2.68-8.17H20.26z"/>
                <path fill="#231F20" d="M26.01,127.21c-1.05,0-1.94-0.22-2.7-0.67c-0.75-0.45-1.33-1.08-1.74-1.9s-0.61-1.78-0.61-2.88 c0-1.09,0.21-2.05,0.61-2.87c0.41-0.83,0.98-1.48,1.71-1.94c0.73-0.46,1.6-0.7,2.58-0.7c0.6,0,1.18,0.1,1.74,0.3 c0.56,0.2,1.07,0.51,1.51,0.93c0.45,0.43,0.8,0.97,1.06,1.65c0.26,0.67,0.39,1.49,0.39,2.46v0.73h-8.44v-1.55h6.41 c0-0.54-0.11-1.03-0.33-1.45c-0.22-0.42-0.53-0.75-0.93-1c-0.4-0.24-0.86-0.36-1.4-0.36c-0.58,0-1.09,0.14-1.51,0.42 c-0.43,0.28-0.77,0.65-1,1.11c-0.23,0.45-0.35,0.95-0.35,1.47v1.21c0,0.71,0.13,1.31,0.38,1.81c0.25,0.5,0.6,0.88,1.05,1.14 c0.45,0.26,0.98,0.39,1.58,0.39c0.39,0,0.75-0.06,1.07-0.17c0.32-0.12,0.6-0.28,0.83-0.51c0.24-0.22,0.42-0.5,0.54-0.84l1.95,0.35 c-0.16,0.58-0.44,1.08-0.84,1.51c-0.4,0.43-0.91,0.77-1.51,1C27.48,127.09,26.78,127.21,26.01,127.21z"/>
                <path fill="#231F20" d="M32.48,126.99v-10.62h2v1.69h0.11c0.19-0.57,0.53-1.02,1.03-1.35c0.49-0.33,1.05-0.49,1.67-0.49 c0.13,0,0.28,0.01,0.46,0.02s0.31,0.02,0.42,0.03v1.97c-0.08-0.02-0.23-0.05-0.44-0.08c-0.21-0.03-0.43-0.05-0.64-0.05 c-0.49,0-0.92,0.1-1.3,0.31c-0.38,0.21-0.68,0.49-0.9,0.85c-0.22,0.36-0.33,0.77-0.33,1.23v6.48H32.48z"/>
                <path fill="#231F20" d="M41.21,130.97c-0.31,0-0.59-0.02-0.85-0.07c-0.25-0.05-0.44-0.1-0.57-0.16l0.5-1.69 c0.38,0.1,0.72,0.15,1.01,0.13c0.29-0.01,0.55-0.12,0.78-0.33c0.23-0.21,0.43-0.55,0.6-1.02l0.26-0.71l-3.88-10.75h2.21l2.69,8.24 h0.11l2.69-8.24h2.22l-4.37,12.03c-0.21,0.55-0.46,1.02-0.77,1.41c-0.31,0.38-0.69,0.67-1.12,0.86 C42.28,130.88,41.78,130.97,41.21,130.97z"/>
                <path fill="#231F20" d="M56.7,112.84l3.94,11.53h0.16l3.94-11.53h2.31l-5.09,14.15h-2.47l-5.09-14.15H56.7z"/>
                <path fill="#231F20" d="M69.57,114.74c-0.36,0-0.67-0.12-0.92-0.36c-0.26-0.24-0.38-0.53-0.38-0.87c0-0.34,0.13-0.63,0.38-0.87 c0.26-0.24,0.57-0.36,0.92-0.36c0.36,0,0.67,0.12,0.92,0.36c0.26,0.24,0.38,0.53,0.38,0.87c0,0.34-0.13,0.63-0.38,0.87 C70.24,114.62,69.93,114.74,69.57,114.74z M68.53,126.99v-10.62h2.07v10.62H68.53z"/>
                <path fill="#231F20" d="M76.96,127.2c-0.86,0-1.62-0.22-2.29-0.66c-0.67-0.44-1.2-1.07-1.58-1.88c-0.38-0.82-0.57-1.8-0.57-2.95 s0.19-2.13,0.58-2.94c0.39-0.81,0.91-1.44,1.59-1.87c0.67-0.44,1.44-0.65,2.29-0.65c0.66,0,1.19,0.11,1.59,0.33 c0.4,0.22,0.72,0.47,0.94,0.77c0.22,0.29,0.4,0.54,0.52,0.77h0.12v-5.26h2.07v14.15H80.2v-1.65h-0.17 c-0.12,0.23-0.3,0.49-0.54,0.77c-0.23,0.29-0.55,0.54-0.95,0.76C78.12,127.09,77.6,127.2,76.96,127.2z M77.41,125.44 c0.59,0,1.1-0.16,1.51-0.47c0.41-0.32,0.73-0.76,0.94-1.32c0.21-0.56,0.32-1.22,0.32-1.96c0-0.74-0.11-1.38-0.32-1.94 c-0.21-0.55-0.53-0.98-0.93-1.29c-0.41-0.31-0.92-0.46-1.52-0.46c-0.62,0-1.14,0.16-1.56,0.49c-0.41,0.32-0.73,0.76-0.94,1.32 c-0.21,0.56-0.31,1.18-0.31,1.89c0,0.71,0.11,1.35,0.32,1.91c0.21,0.57,0.53,1.01,0.94,1.34S76.8,125.44,77.41,125.44z"/>
                <path fill="#231F20" d="M89.34,127.21c-1.05,0-1.94-0.22-2.7-0.67c-0.75-0.45-1.33-1.08-1.74-1.9s-0.61-1.78-0.61-2.88 c0-1.09,0.21-2.05,0.61-2.87c0.41-0.83,0.98-1.48,1.71-1.94c0.73-0.46,1.6-0.7,2.58-0.7c0.6,0,1.18,0.1,1.74,0.3 c0.56,0.2,1.07,0.51,1.51,0.93c0.45,0.43,0.8,0.97,1.06,1.65c0.26,0.67,0.39,1.49,0.39,2.46v0.73h-8.44v-1.55h6.41 c0-0.54-0.11-1.03-0.33-1.45c-0.22-0.42-0.53-0.75-0.93-1c-0.4-0.24-0.86-0.36-1.4-0.36c-0.58,0-1.09,0.14-1.51,0.42 c-0.43,0.28-0.77,0.65-1,1.11c-0.23,0.45-0.35,0.95-0.35,1.47v1.21c0,0.71,0.13,1.31,0.38,1.81c0.25,0.5,0.6,0.88,1.05,1.14 c0.45,0.26,0.98,0.39,1.58,0.39c0.39,0,0.75-0.06,1.07-0.17c0.32-0.12,0.6-0.28,0.83-0.51c0.24-0.22,0.42-0.5,0.54-0.84l1.95,0.35 c-0.16,0.58-0.44,1.08-0.84,1.51c-0.4,0.43-0.91,0.77-1.51,1C90.81,127.09,90.12,127.21,89.34,127.21z"/>
                <path fill="#231F20" d="M100.28,127.21c-1,0-1.86-0.23-2.6-0.68c-0.74-0.46-1.32-1.09-1.73-1.92c-0.41-0.82-0.62-1.78-0.62-2.87 c0-1.1,0.21-2.06,0.62-2.89c0.41-0.82,0.99-1.46,1.73-1.92c0.74-0.46,1.61-0.68,2.6-0.68c1,0,1.86,0.23,2.61,0.68 c0.74,0.45,1.32,1.09,1.73,1.92c0.41,0.83,0.62,1.79,0.62,2.89c0,1.1-0.21,2.06-0.62,2.87c-0.41,0.82-0.99,1.46-1.73,1.92 C102.14,126.98,101.28,127.21,100.28,127.21z M100.29,125.47c0.65,0,1.18-0.17,1.6-0.51c0.42-0.34,0.74-0.8,0.94-1.36 c0.21-0.57,0.31-1.19,0.31-1.87c0-0.68-0.1-1.3-0.31-1.87c-0.21-0.57-0.52-1.03-0.94-1.37c-0.42-0.35-0.96-0.52-1.6-0.52 c-0.65,0-1.18,0.17-1.61,0.52c-0.43,0.35-0.74,0.8-0.95,1.37c-0.21,0.57-0.31,1.19-0.31,1.87c0,0.68,0.1,1.31,0.31,1.87 c0.21,0.57,0.52,1.02,0.95,1.36C99.1,125.3,99.64,125.47,100.29,125.47z"/>
                <path fill="#231F20" d="M119.79,116.56c-0.07-0.65-0.38-1.16-0.91-1.52c-0.53-0.36-1.21-0.54-2.02-0.54c-0.58,0-1.08,0.09-1.51,0.27 c-0.42,0.18-0.75,0.43-0.98,0.75c-0.23,0.32-0.35,0.67-0.35,1.08c0,0.34,0.08,0.63,0.24,0.87c0.16,0.24,0.37,0.45,0.63,0.61 c0.26,0.16,0.54,0.3,0.84,0.41c0.3,0.11,0.59,0.2,0.86,0.26l1.38,0.36c0.45,0.11,0.91,0.26,1.39,0.45 c0.48,0.19,0.91,0.44,1.32,0.75c0.41,0.31,0.73,0.69,0.99,1.15c0.25,0.45,0.38,1,0.38,1.64c0,0.8-0.21,1.51-0.62,2.14 c-0.41,0.62-1.01,1.11-1.79,1.47c-0.78,0.36-1.73,0.54-2.83,0.54c-1.06,0-1.98-0.17-2.75-0.51c-0.77-0.34-1.38-0.81-1.82-1.43 c-0.44-0.62-0.68-1.36-0.72-2.21h2.14c0.04,0.51,0.21,0.94,0.5,1.28c0.29,0.34,0.67,0.59,1.13,0.76c0.46,0.16,0.96,0.24,1.51,0.24 c0.6,0,1.14-0.09,1.61-0.29c0.47-0.19,0.85-0.46,1.12-0.8c0.27-0.34,0.41-0.74,0.41-1.2c0-0.42-0.12-0.76-0.35-1.03 c-0.24-0.27-0.56-0.49-0.96-0.67c-0.4-0.17-0.86-0.33-1.37-0.46l-1.67-0.46c-1.13-0.31-2.03-0.76-2.69-1.36 c-0.66-0.6-0.99-1.39-0.99-2.38c0-0.81,0.22-1.53,0.66-2.14c0.44-0.61,1.04-1.08,1.8-1.42c0.76-0.34,1.61-0.51,2.56-0.51 c0.96,0,1.8,0.17,2.54,0.51c0.73,0.34,1.31,0.8,1.74,1.38c0.42,0.59,0.64,1.26,0.66,2.02H119.79z"/>
                <path fill="#231F20" d="M124.04,130.97v-14.6h2.02v1.72h0.17c0.12-0.22,0.29-0.48,0.52-0.77c0.22-0.29,0.54-0.54,0.94-0.77 c0.4-0.22,0.93-0.33,1.59-0.33c0.86,0,1.62,0.21,2.29,0.65c0.67,0.43,1.2,1.06,1.59,1.87c0.39,0.81,0.58,1.79,0.58,2.94 s-0.19,2.13-0.58,2.95c-0.38,0.82-0.91,1.45-1.57,1.88c-0.67,0.44-1.43,0.66-2.29,0.66c-0.64,0-1.17-0.11-1.58-0.33 c-0.41-0.21-0.73-0.47-0.96-0.76c-0.23-0.29-0.41-0.55-0.53-0.77h-0.12v5.63H124.04z M126.07,121.69c0,0.75,0.11,1.4,0.32,1.96 c0.22,0.56,0.53,1,0.94,1.32c0.41,0.31,0.91,0.47,1.51,0.47c0.62,0,1.13-0.16,1.55-0.49c0.42-0.33,0.73-0.78,0.95-1.34 c0.21-0.57,0.32-1.2,0.32-1.91c0-0.7-0.11-1.33-0.31-1.89c-0.21-0.56-0.52-1-0.94-1.32c-0.42-0.32-0.94-0.49-1.56-0.49 c-0.6,0-1.11,0.16-1.52,0.46c-0.41,0.31-0.72,0.74-0.94,1.29C126.17,120.3,126.07,120.95,126.07,121.69z"/>
                <path fill="#231F20" d="M140.24,127.21c-1.05,0-1.94-0.22-2.7-0.67c-0.75-0.45-1.33-1.08-1.74-1.9c-0.41-0.82-0.61-1.78-0.61-2.88 c0-1.09,0.21-2.05,0.61-2.87c0.41-0.83,0.98-1.48,1.71-1.94c0.73-0.46,1.6-0.7,2.58-0.7c0.6,0,1.18,0.1,1.74,0.3 c0.56,0.2,1.07,0.51,1.51,0.93c0.45,0.43,0.8,0.97,1.06,1.65s0.39,1.49,0.39,2.46v0.73h-8.44v-1.55h6.41 c0-0.54-0.11-1.03-0.33-1.45c-0.22-0.42-0.53-0.75-0.93-1c-0.4-0.24-0.86-0.36-1.4-0.36c-0.58,0-1.09,0.14-1.51,0.42 c-0.43,0.28-0.77,0.65-1,1.11c-0.23,0.45-0.35,0.95-0.35,1.47v1.21c0,0.71,0.13,1.31,0.38,1.81c0.25,0.5,0.6,0.88,1.05,1.14 c0.45,0.26,0.98,0.39,1.58,0.39c0.39,0,0.75-0.06,1.07-0.17c0.32-0.12,0.6-0.28,0.83-0.51c0.24-0.22,0.42-0.5,0.54-0.84l1.95,0.35 c-0.16,0.58-0.44,1.08-0.84,1.51c-0.4,0.43-0.91,0.77-1.51,1C141.7,127.09,141.01,127.21,140.24,127.21z"/>
                <path fill="#231F20" d="M149.79,127.23c-0.67,0-1.28-0.13-1.83-0.38c-0.54-0.25-0.97-0.62-1.29-1.09c-0.32-0.48-0.47-1.07-0.47-1.76 c0-0.6,0.12-1.09,0.35-1.48c0.23-0.39,0.54-0.69,0.93-0.92c0.39-0.23,0.83-0.4,1.31-0.51c0.48-0.12,0.98-0.2,1.48-0.26 c0.64-0.07,1.15-0.13,1.55-0.18c0.39-0.05,0.68-0.13,0.86-0.24c0.18-0.11,0.27-0.29,0.27-0.54v-0.05c0-0.6-0.17-1.07-0.51-1.4 c-0.34-0.33-0.84-0.5-1.51-0.5c-0.7,0-1.24,0.16-1.64,0.46c-0.4,0.31-0.67,0.65-0.83,1.02l-1.94-0.44 c0.23-0.65,0.57-1.17,1.01-1.57c0.44-0.4,0.95-0.69,1.54-0.87c0.58-0.18,1.19-0.27,1.83-0.27c0.42,0,0.87,0.05,1.35,0.15 c0.48,0.1,0.92,0.28,1.34,0.54c0.42,0.26,0.76,0.64,1.03,1.12c0.27,0.49,0.4,1.12,0.4,1.89v7.05h-2.02v-1.45h-0.08 c-0.13,0.27-0.34,0.53-0.6,0.79c-0.27,0.26-0.61,0.47-1.03,0.64C150.88,127.14,150.38,127.23,149.79,127.23z M150.24,125.57 c0.57,0,1.06-0.11,1.47-0.34c0.41-0.22,0.72-0.52,0.93-0.89s0.32-0.76,0.32-1.18v-1.37c-0.07,0.07-0.22,0.14-0.43,0.21 c-0.21,0.06-0.45,0.12-0.72,0.16s-0.53,0.08-0.78,0.12c-0.26,0.03-0.47,0.06-0.63,0.08c-0.4,0.05-0.77,0.14-1.1,0.26 c-0.33,0.12-0.59,0.29-0.79,0.51c-0.2,0.22-0.29,0.52-0.29,0.89c0,0.51,0.19,0.9,0.57,1.16 C149.17,125.44,149.66,125.57,150.24,125.57z"/>
                <path fill="#231F20" d="M157.39,126.99v-14.15h2.07v14.15H157.39z M159.29,123.39l-0.02-2.52h0.36l4.23-4.49h2.48l-4.82,5.11h-0.32 L159.29,123.39z M164.09,126.99l-3.8-5.04l1.42-1.44l4.91,6.49H164.09z"/>
                <path fill="#231F20" d="M175.78,118.97l-1.87,0.33c-0.08-0.24-0.2-0.47-0.37-0.68s-0.39-0.39-0.68-0.53 c-0.29-0.14-0.64-0.21-1.07-0.21c-0.58,0-1.07,0.13-1.46,0.39c-0.39,0.26-0.59,0.59-0.59,1c0,0.35,0.13,0.64,0.39,0.86 c0.26,0.21,0.69,0.39,1.27,0.53l1.69,0.39c0.98,0.23,1.7,0.58,2.19,1.05c0.48,0.47,0.72,1.08,0.72,1.83c0,0.64-0.18,1.2-0.55,1.7 c-0.37,0.49-0.87,0.88-1.53,1.16c-0.65,0.28-1.41,0.42-2.26,0.42c-1.19,0-2.16-0.26-2.91-0.77c-0.75-0.51-1.21-1.23-1.38-2.17 l2-0.3c0.12,0.52,0.38,0.91,0.77,1.18c0.39,0.26,0.89,0.39,1.51,0.39c0.68,0,1.22-0.14,1.62-0.42s0.61-0.63,0.61-1.04 c0-0.33-0.12-0.61-0.37-0.83c-0.25-0.23-0.63-0.4-1.13-0.51l-1.79-0.39c-0.99-0.22-1.72-0.58-2.2-1.08 c-0.47-0.49-0.71-1.12-0.71-1.87c0-0.63,0.18-1.18,0.53-1.65c0.35-0.47,0.83-0.84,1.45-1.1c0.62-0.27,1.32-0.4,2.12-0.4 c1.15,0,2.05,0.25,2.71,0.74C175.14,117.48,175.57,118.14,175.78,118.97z"/>
                <path fill="#231F20" d="M181.71,112.84h2.43l3.69,6.43h0.15l3.7-6.43h2.43l-5.13,8.6v5.55h-2.13v-5.55L181.71,112.84z"/>
                <path fill="#231F20" d="M198.31,127.21c-1,0-1.86-0.23-2.6-0.68c-0.74-0.46-1.32-1.09-1.73-1.92c-0.41-0.82-0.62-1.78-0.62-2.87 c0-1.1,0.21-2.06,0.62-2.89c0.41-0.82,0.99-1.46,1.73-1.92c0.74-0.46,1.61-0.68,2.6-0.68s1.86,0.23,2.61,0.68 c0.74,0.45,1.32,1.09,1.73,1.92c0.41,0.83,0.62,1.79,0.62,2.89c0,1.1-0.21,2.06-0.62,2.87c-0.41,0.82-0.99,1.46-1.73,1.92 C200.17,126.98,199.31,127.21,198.31,127.21z M198.32,125.47c0.65,0,1.18-0.17,1.6-0.51c0.42-0.34,0.74-0.8,0.94-1.36 c0.21-0.57,0.31-1.19,0.31-1.87c0-0.68-0.1-1.3-0.31-1.87c-0.21-0.57-0.52-1.03-0.94-1.37c-0.42-0.35-0.96-0.52-1.6-0.52 c-0.65,0-1.18,0.17-1.61,0.52c-0.43,0.35-0.74,0.8-0.95,1.37c-0.21,0.57-0.31,1.19-0.31,1.87c0,0.68,0.1,1.31,0.31,1.87 c0.21,0.57,0.52,1.02,0.95,1.36C197.13,125.3,197.67,125.47,198.32,125.47z"/>
                <path fill="#231F20" d="M211.89,122.59v-6.21h2.07v10.62h-2.03v-1.84h-0.11c-0.24,0.57-0.63,1.04-1.17,1.41 c-0.54,0.38-1.2,0.56-2,0.56c-0.68,0-1.28-0.15-1.81-0.45c-0.52-0.3-0.93-0.75-1.23-1.34c-0.3-0.59-0.44-1.33-0.44-2.21v-6.75 h2.07v6.5c0,0.72,0.2,1.3,0.6,1.73c0.4,0.43,0.92,0.64,1.56,0.64c0.39,0,0.77-0.1,1.16-0.29c0.38-0.19,0.7-0.49,0.96-0.88 C211.78,123.69,211.9,123.19,211.89,122.59z"/>
                <path fill="#231F20" d="M216.35,126.99v-10.62h2v1.69h0.11c0.19-0.57,0.53-1.02,1.03-1.35c0.49-0.33,1.05-0.49,1.67-0.49 c0.13,0,0.28,0.01,0.46,0.02c0.18,0.01,0.31,0.02,0.42,0.03v1.97c-0.08-0.02-0.23-0.05-0.44-0.08c-0.21-0.03-0.43-0.05-0.64-0.05 c-0.49,0-0.92,0.1-1.3,0.31c-0.38,0.21-0.68,0.49-0.9,0.85c-0.22,0.36-0.33,0.77-0.33,1.23v6.48H216.35z"/>
                <path fill="#231F20" d="M228.37,126.99v-14.15h2.13v12.31h6.41v1.84H228.37z"/>
                <path fill="#231F20" d="M241.89,127.23c-0.67,0-1.28-0.13-1.83-0.38c-0.54-0.25-0.97-0.62-1.29-1.09c-0.32-0.48-0.47-1.07-0.47-1.76 c0-0.6,0.12-1.09,0.35-1.48c0.23-0.39,0.54-0.69,0.93-0.92c0.39-0.23,0.83-0.4,1.31-0.51c0.48-0.12,0.98-0.2,1.48-0.26 c0.64-0.07,1.15-0.13,1.55-0.18c0.4-0.05,0.68-0.13,0.86-0.24c0.18-0.11,0.27-0.29,0.27-0.54v-0.05c0-0.6-0.17-1.07-0.51-1.4 c-0.34-0.33-0.84-0.5-1.51-0.5c-0.7,0-1.24,0.16-1.64,0.46c-0.4,0.31-0.67,0.65-0.83,1.02l-1.94-0.44 c0.23-0.65,0.57-1.17,1.01-1.57c0.44-0.4,0.95-0.69,1.54-0.87c0.58-0.18,1.19-0.27,1.83-0.27c0.42,0,0.87,0.05,1.35,0.15 c0.48,0.1,0.92,0.28,1.34,0.54c0.42,0.26,0.76,0.64,1.03,1.12c0.27,0.49,0.4,1.12,0.4,1.89v7.05h-2.02v-1.45h-0.08 c-0.13,0.27-0.34,0.53-0.6,0.79c-0.27,0.26-0.61,0.47-1.03,0.64C242.97,127.14,242.47,127.23,241.89,127.23z M242.33,125.57 c0.57,0,1.06-0.11,1.47-0.34c0.41-0.22,0.72-0.52,0.93-0.89s0.32-0.76,0.32-1.18v-1.37c-0.07,0.07-0.22,0.14-0.43,0.21 c-0.21,0.06-0.45,0.12-0.72,0.16c-0.27,0.04-0.53,0.08-0.78,0.12c-0.26,0.03-0.47,0.06-0.63,0.08c-0.4,0.05-0.77,0.14-1.1,0.26 c-0.33,0.12-0.59,0.29-0.79,0.51c-0.2,0.22-0.29,0.52-0.29,0.89c0,0.51,0.19,0.9,0.57,1.16 C241.27,125.44,241.75,125.57,242.33,125.57z"/>
                <path fill="#231F20" d="M251.55,120.69v6.3h-2.07v-10.62h1.98v1.73h0.13c0.25-0.56,0.63-1.01,1.15-1.36 c0.53-0.34,1.18-0.51,1.98-0.51c0.72,0,1.36,0.15,1.9,0.45s0.96,0.75,1.27,1.34c0.3,0.6,0.45,1.33,0.45,2.21v6.75h-2.07v-6.5 c0-0.77-0.2-1.37-0.6-1.81c-0.4-0.44-0.95-0.65-1.65-0.65c-0.48,0-0.9,0.11-1.28,0.31c-0.37,0.21-0.66,0.51-0.88,0.91 C251.65,119.65,251.55,120.13,251.55,120.69z"/>
                <path fill="#231F20" d="M265.17,131.19c-0.84,0-1.57-0.11-2.17-0.33c-0.61-0.22-1.1-0.51-1.48-0.88c-0.38-0.36-0.67-0.76-0.86-1.19 l1.78-0.73c0.12,0.2,0.29,0.42,0.5,0.65c0.21,0.23,0.49,0.42,0.86,0.58c0.36,0.16,0.83,0.24,1.4,0.24c0.78,0,1.43-0.19,1.94-0.57 c0.51-0.38,0.77-0.98,0.77-1.81v-2.09h-0.13c-0.12,0.22-0.3,0.48-0.53,0.75c-0.23,0.28-0.55,0.52-0.96,0.72s-0.93,0.3-1.58,0.3 c-0.84,0-1.59-0.2-2.26-0.59c-0.67-0.39-1.2-0.98-1.59-1.75c-0.39-0.77-0.58-1.72-0.58-2.85s0.19-2.1,0.58-2.9 c0.39-0.81,0.91-1.42,1.59-1.85c0.67-0.43,1.44-0.65,2.29-0.65c0.66,0,1.19,0.11,1.6,0.33c0.4,0.22,0.72,0.47,0.95,0.77 c0.23,0.29,0.4,0.54,0.53,0.77h0.15v-1.72h2.02v10.85c0,0.91-0.21,1.66-0.63,2.25c-0.42,0.58-1,1.02-1.72,1.3 C266.88,131.05,266.07,131.19,265.17,131.19z M265.15,125.12c0.59,0,1.1-0.14,1.51-0.42c0.41-0.28,0.73-0.68,0.94-1.2 c0.21-0.52,0.32-1.15,0.32-1.88c0-0.71-0.11-1.34-0.32-1.88c-0.21-0.54-0.53-0.97-0.93-1.28c-0.41-0.31-0.92-0.46-1.52-0.46 c-0.62,0-1.14,0.16-1.56,0.48c-0.41,0.32-0.73,0.75-0.94,1.3c-0.21,0.55-0.31,1.16-0.31,1.84c0,0.7,0.11,1.31,0.32,1.83 c0.21,0.53,0.53,0.94,0.94,1.23C264.02,124.97,264.53,125.12,265.15,125.12z"/>
                <path fill="#231F20" d="M279.06,122.59v-6.21h2.07v10.62h-2.03v-1.84h-0.11c-0.24,0.57-0.63,1.04-1.17,1.41 c-0.54,0.38-1.2,0.56-2,0.56c-0.68,0-1.28-0.15-1.81-0.45c-0.52-0.3-0.93-0.75-1.23-1.34c-0.3-0.59-0.44-1.33-0.44-2.21v-6.75 h2.07v6.5c0,0.72,0.2,1.3,0.6,1.73c0.4,0.43,0.92,0.64,1.56,0.64c0.39,0,0.77-0.1,1.16-0.29c0.38-0.19,0.7-0.49,0.96-0.88 C278.94,123.69,279.07,123.19,279.06,122.59z"/>
                <path fill="#231F20" d="M286.61,127.23c-0.67,0-1.28-0.13-1.83-0.38c-0.54-0.25-0.97-0.62-1.29-1.09c-0.32-0.48-0.47-1.07-0.47-1.76 c0-0.6,0.12-1.09,0.35-1.48c0.23-0.39,0.54-0.69,0.93-0.92c0.39-0.23,0.83-0.4,1.31-0.51c0.48-0.12,0.98-0.2,1.48-0.26 c0.64-0.07,1.15-0.13,1.55-0.18c0.39-0.05,0.68-0.13,0.86-0.24c0.18-0.11,0.27-0.29,0.27-0.54v-0.05c0-0.6-0.17-1.07-0.51-1.4 c-0.34-0.33-0.84-0.5-1.51-0.5c-0.7,0-1.24,0.16-1.64,0.46c-0.4,0.31-0.67,0.65-0.83,1.02l-1.94-0.44 c0.23-0.65,0.57-1.17,1.01-1.57c0.44-0.4,0.95-0.69,1.54-0.87c0.58-0.18,1.19-0.27,1.83-0.27c0.42,0,0.87,0.05,1.35,0.15 c0.48,0.1,0.92,0.28,1.34,0.54c0.42,0.26,0.76,0.64,1.03,1.12c0.27,0.49,0.4,1.12,0.4,1.89v7.05h-2.02v-1.45h-0.08 c-0.13,0.27-0.34,0.53-0.6,0.79c-0.27,0.26-0.61,0.47-1.03,0.64C287.69,127.14,287.19,127.23,286.61,127.23z M287.05,125.57 c0.57,0,1.06-0.11,1.47-0.34c0.41-0.22,0.72-0.52,0.93-0.89s0.32-0.76,0.32-1.18v-1.37c-0.07,0.07-0.22,0.14-0.43,0.21 c-0.21,0.06-0.45,0.12-0.72,0.16c-0.27,0.04-0.53,0.08-0.78,0.12c-0.26,0.03-0.47,0.06-0.63,0.08c-0.4,0.05-0.77,0.14-1.1,0.26 c-0.33,0.12-0.59,0.29-0.79,0.51c-0.2,0.22-0.29,0.52-0.29,0.89c0,0.51,0.19,0.9,0.57,1.16 C285.99,125.44,286.47,125.57,287.05,125.57z"/>
                <path fill="#231F20" d="M298.65,131.19c-0.84,0-1.57-0.11-2.17-0.33c-0.61-0.22-1.10-0.51-1.48-0.88c-0.38-0.36-0.67-0.76-0.86-1.19 l1.78-0.73c0.12,0.2,0.29,0.42,0.5,0.65c0.21,0.23,0.49,0.42,0.86,0.58c0.36,0.16,0.83,0.24,1.4,0.24c0.78,0,1.43-0.19,1.94-0.57 c0.51-0.38,0.77-0.98,0.77-1.81v-2.09h-0.13c-0.12,0.22-0.3,0.48-0.53,0.75c-0.23,0.28-0.55,0.52-0.96,0.72s-0.93,0.3-1.58,0.3 c-0.84,0-1.59-0.2-2.26-0.59c-0.67-0.39-1.2-0.98-1.59-1.75c-0.39-0.77-0.58-1.72-0.58-2.85s0.19-2.1,0.58-2.9 c0.39-0.81,0.91-1.42,1.59-1.85c0.67-0.43,1.44-0.65,2.29-0.65c0.66,0,1.19,0.11,1.6,0.33c0.4,0.22,0.72,0.47,0.95,0.77 c0.23,0.29,0.4,0.54,0.53,0.77h0.15v-1.72h2.02v10.85c0,0.91-0.21,1.66-0.63,2.25c-0.42,0.58-1,1.02-1.72,1.3 C300.37,131.05,299.56,131.19,298.65,131.19z M298.63,125.12c0.59,0,1.10-0.14,1.51-0.42c0.41-0.28,0.73-0.68,0.94-1.2 c0.21-0.52,0.32-1.15,0.32-1.88c0-0.71-0.11-1.34-0.32-1.88c-0.21-0.54-0.53-0.97-0.93-1.28c-0.41-0.31-0.92-0.46-1.52-0.46 c-0.62,0-1.14,0.16-1.56,0.48c-0.41,0.32-0.73,0.75-0.94,1.3c-0.21,0.55-0.31,1.16-0.31,1.84c0,0.7,0.11,1.31,0.32,1.83 c0.21,0.53,0.53,0.94,0.94,1.23C297.50,124.97,298.02,125.12,298.63,125.12z"/>
                <path fill="#231F20" d="M310.4,127.21c-1.05,0-1.94-0.22-2.7-0.67c-0.75-0.45-1.33-1.08-1.74-1.9c-0.41-0.82-0.61-1.78-0.61-2.88 c0-1.09,0.21-2.05,0.61-2.87c0.41-0.83,0.98-1.48,1.71-1.94c0.73-0.46,1.6-0.7,2.58-0.7c0.6,0,1.18,0.1,1.74,0.3 c0.56,0.2,1.07,0.51,1.51,0.93c0.45,0.43,0.8,0.97,1.06,1.65s0.39,1.49,0.39,2.46v0.73h-8.44v-1.55h6.41 c0-0.54-0.11-1.03-0.33-1.45c-0.22-0.42-0.53-0.75-0.93-1c-0.4-0.24-0.86-0.36-1.4-0.36c-0.58,0-1.09,0.14-1.51,0.42 c-0.43,0.28-0.77,0.65-1,1.11c-0.23,0.45-0.35,0.95-0.35,1.47v1.21c0,0.71,0.13,1.31,0.38,1.81c0.25,0.5,0.6,0.88,1.05,1.14 c0.45,0.26,0.98,0.39,1.58,0.39c0.39,0,0.75-0.06,1.07-0.17c0.32-0.12,0.6-0.28,0.83-0.51c0.24-0.22,0.42-0.5,0.54-0.84l1.95,0.35 c-0.16,0.58-0.44,1.08-0.84,1.51c-0.4,0.43-0.91,0.77-1.51,1C311.86,127.09,311.17,127.21,310.4,127.21z"/>
                <path fill="#231F20" d="M318.23,127.12c-0.38,0-0.7-0.13-0.97-0.4c-0.27-0.27-0.41-0.59-0.41-0.98c0-0.38,0.14-0.7,0.41-0.97 c0.27-0.27,0.6-0.4,0.97-0.4c0.38,0,0.7,0.13,0.98,0.4c0.27,0.27,0.41,0.59,0.41,0.97c0,0.25-0.07,0.49-0.19,0.69 c-0.13,0.21-0.3,0.38-0.5,0.5C318.71,127.06,318.48,127.12,318.23,127.12z"/>
              </g>
              <g>
                <path fill="#FF4200" d="M32.78,3.6H0v84.06h32.78c26.42,0,44.67-18.37,44.67-42.03v-0.24C77.45,21.73,59.2,3.6,32.78,3.6z"/>
                <path fill="#231F20" d="M60.09,56.2l-30.9,17.84c-3.85,2.22-8.66-0.56-8.66-5V33.36c0-4.45,4.81-7.23,8.66-5l30.9,17.84 C63.94,48.42,63.94,53.98,60.09,56.2z"/>
                <path fill="#FF4200" d="M227.97,0h18.25v87.66h-18.25V0z"/>
                <path fill="#FF4200" d="M257.53,102.79l6.12-13.21c2.4,1.44,5.41,2.52,7.81,2.52c3.12,0,4.8-0.96,6.36-4.2l-25.22-64.6h19.33 l14.65,43.83l14.05-43.83h18.97l-24.74,65.93c-4.92,13.09-10.21,18.01-21.13,18.01C267.14,107.23,262.21,105.55,257.53,102.79z"/>
                <path fill="#FF4200" d="M144,22.95h-18.25v36.96h-0.05c0.01,0.15,0.04,0.29,0.04,0.43c0,6.2-5.03,11.23-11.23,11.23 c-6.2,0-11.23-5.03-11.23-11.23c0-0.15,0.04-0.29,0.04-0.43h-0.04V22.95H85.04v37.1h0.1c0.92,15.47,13.72,27.75,29.42,27.75 c15.59,0,28.31-12.11,29.39-27.42H144V22.95z"/>
                <path fill="#FF4200" d="M170.42,79.29v8.41h-18.26V0h18.26v32.56c4.45-6.01,10.57-10.45,20.06-10.45c15.02,0,29.32,11.77,29.32,33.28 v0.24c0,21.5-14.06,33.28-29.32,33.28C180.76,88.9,174.75,84.46,170.42,79.29z M201.54,55.62v-0.24 c0-10.69-7.21-17.78-15.74-17.78s-15.62,7.09-15.62,17.78v0.24c0,10.69,7.09,17.78,15.62,17.78S201.54,66.44,201.54,55.62z"/>
                <path fill="#FFFFFF" d="M55.47,50.3L26.62,66.96c-3.6,2.08-8.09-0.52-8.09-4.67V28.97c0-4.15,4.49-6.75,8.09-4.67l28.85,16.66 C59.06,43.04,59.06,48.23,55.47,50.3z"/>
              </g>
            </svg>
          </div>

          <div className="flex items-center gap-4">
            {!isPro && (
              <div className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-1.5">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">
                  {remainingMinutes} min left today
                </span>
              </div>
            )}
            <button
              onClick={() => setIsPro(!isPro)}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all ${
                isPro
                  ? "bg-gradient-to-r from-amber-500 to-amber-600 text-white shadow-md"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}
            >
              <Crown className="h-4 w-4" />
              {isPro ? "Pro Member" : "Upgrade to Pro"}
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-80 border-r border-border bg-sidebar p-6">
          <div className="space-y-6">
            <div>
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Upload Video
              </h2>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={handleFileSelect}
                style={{ display: "none" }}
              />
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-sm font-medium transition-all ${
                  isDragging
                    ? "border-blue-500 bg-blue-50 text-blue-600"
                    : "border-border bg-secondary/50 hover:border-blue-500 hover:bg-secondary hover:text-blue-600"
                }`}
              >
                <Upload className="pointer-events-none h-5 w-5" />
                <span className="pointer-events-none">{isDragging ? "Drop to upload" : "Drop video or browse"}</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                MP4, MOV, AVI, MKV, WEBM • Max 5GB
              </p>

              {/* URL Import */}
              <div className="mt-3">
                {showUrlInput ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleUrlImport()}
                      placeholder="Paste video URL..."
                      autoFocus
                      className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={handleUrlImport}
                      className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Go
                    </button>
                    <button
                      onClick={() => { setShowUrlInput(false); setUrlInput(""); }}
                      className="rounded-lg border border-border px-2 py-2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowUrlInput(true)}
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-blue-600 transition-colors"
                  >
                    <Link className="h-3.5 w-3.5" />
                    Import from URL
                  </button>
                )}
              </div>

              {/* Screen Capture */}
              <div className="mt-2">
                {isCapturing ? (
                  <button
                    onClick={stopScreenCapture}
                    className="flex items-center gap-2 text-xs text-red-500 hover:text-red-600 transition-colors"
                  >
                    <StopCircle className="h-3.5 w-3.5" />
                    Stop screen capture
                  </button>
                ) : (
                  <button
                    onClick={handleScreenCapture}
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-blue-600 transition-colors"
                  >
                    <Monitor className="h-3.5 w-3.5" />
                    Capture from screen
                  </button>
                )}
              </div>

            </div>

            {!isPro && (
              <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Daily Usage</span>
                  <span className="font-semibold text-foreground">
                    {dailyMinutesUsed}/{dailyLimit} min
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all"
                    style={{ width: `${usagePercentage}%` }}
                  />
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    +15 min per ad ({3 - adsWatchedToday} left today)
                  </p>
                  <button
                    onClick={watchAd}
                    disabled={adsWatchedToday >= 3}
                    className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Watch Ad
                  </button>
                </div>
              </div>
            )}

            <div>
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Recent Videos
              </h2>
              <div className="space-y-3">
                {videos.map((video) => (
                  <div
                    key={video.id}
                    onClick={() => loadVideo(video)}
                    className={`group rounded-lg border p-3 transition-all ${
                      video.status === "ready"
                        ? "cursor-pointer hover:border-blue-400 hover:shadow-md"
                        : "cursor-default opacity-70"
                    } ${
                      activeVideo.id === video.id
                        ? "border-blue-500 bg-blue-50 shadow-sm"
                        : "border-border bg-white"
                    }`}
                  >
                    <div className="mb-2 aspect-video overflow-hidden rounded bg-background">
                      {video.thumbnail ? (
                        <img
                          src={video.thumbnail}
                          alt={video.title}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center bg-muted">
                          <FileText className="h-8 w-8 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <h3 className="mb-1 truncate text-sm font-medium">
                      {video.title}
                    </h3>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{video.language}</span>
                      <span>{video.duration}</span>
                    </div>
                    {video.status === "processing" && (
                      <div className="mt-2">
                        <div className="flex items-center gap-2 text-xs text-blue-600">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Processing {video.progress}%</span>
                        </div>
                        <div className="mt-1 h-1 overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all"
                            style={{ width: `${video.progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1">
          <div className="mx-auto max-w-6xl p-6">
            {!isPro && (
              <div className="mb-4 rounded-lg border border-border bg-secondary/50 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Sponsored Content
                  </p>
                  <div className="rounded bg-muted px-2 py-1 text-xs font-medium text-foreground">
                    Ad
                  </div>
                </div>
                <div className="mt-2 text-sm text-foreground">
                  Remove ads and get unlimited access with Pro
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div
                ref={playerRef}
                className="relative overflow-hidden rounded-lg bg-black"
                onMouseMove={revealControls}
                onMouseLeave={startHideTimer}
              >
                {/* Video */}
                <video
                  ref={videoRef}
                  className="aspect-video w-full block cursor-pointer"
                  onClick={togglePlay}
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={handleLoadedMetadata}
                  onEnded={handleEnded}
                  onPlay={() => {
                    setIsPlaying(true);
                    setVideoError(null);
                    clearTimeout(hideTimerRef.current);
                    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
                    if (audioTrack === "english") startTranslation(OPENAI_KEY);
                  }}
                  onPause={() => {
                    setIsPlaying(false);
                    setControlsVisible(true);
                    clearTimeout(hideTimerRef.current);
                    if (audioTrack === "english") stopTranslation();
                  }}
                  onWaiting={() => setIsBuffering(true)}
                  onCanPlay={() => {
                    setIsBuffering(false);
                    if (autoPlayRef.current) {
                      autoPlayRef.current = false;
                      videoRef.current?.play().catch(() => {});
                    }
                  }}
                  onError={() => {
                    const err = videoRef.current?.error;
                    const msgs: Record<number, string> = {
                      1: "Video loading was aborted.",
                      2: "Network error while loading video.",
                      3: "Video decoding failed — the format may not be supported.",
                      4: "Video source not found or not a direct video URL.",
                    };
                    setVideoError(err ? (msgs[err.code] ?? "Failed to load video.") : "Failed to load video.");
                    setIsBuffering(false);
                    autoPlayRef.current = false;
                  }}
                />

                {/* Buffering spinner */}
                {isBuffering && !videoError && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <Loader2 className="h-12 w-12 text-white animate-spin opacity-80" />
                  </div>
                )}

                {/* Error overlay */}
                {videoError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center">
                    <div className="text-red-400 text-sm font-medium">{videoError}</div>
                    <p className="text-white/50 text-xs max-w-xs">
                      Only direct video URLs work (MP4, WebM, MOV). YouTube and streaming links are not supported.
                    </p>
                  </div>
                )}

                {/* Center play button (visible when paused and no error) */}
                {!isPlaying && !videoError && !isBuffering && (
                  <div
                    className="absolute inset-0 flex items-center justify-center cursor-pointer"
                    onClick={togglePlay}
                  >
                    <div className="rounded-full bg-black/50 p-5 backdrop-blur-sm transition-transform hover:scale-110">
                      <Play className="h-10 w-10 text-white" fill="currentColor" />
                    </div>
                  </div>
                )}

                {/* LIVE badge */}
                {isCapturing && (
                  <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded bg-red-600 px-2 py-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
                    <span className="text-xs font-bold text-white tracking-wider">LIVE</span>
                  </div>
                )}

                {/* Translating badge */}
                {isTranslating && (
                  <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded bg-blue-700 px-2 py-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
                    <span className="text-xs font-bold text-white">EN</span>
                  </div>
                )}

                {/* Translation subtitle overlay */}
                {isTranslating && translationText && (
                  <div className="absolute inset-x-0 bottom-20 flex justify-center px-6 pointer-events-none">
                    <div className="rounded-md bg-black/80 px-4 py-2 text-sm text-white text-center max-w-xl leading-snug">
                      {translationText}
                    </div>
                  </div>
                )}

                {/* Controls overlay */}
                <div
                  className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-4 transition-opacity duration-300 ${
                    controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
                  }`}
                >
                  {/* Inline URL input — shown when Play URL is active */}
                  {showPlayerUrlInput && (
                    <div className="mb-3 flex items-center gap-2">
                      <Link className="h-4 w-4 shrink-0 text-white/70" />
                      <input
                        type="text"
                        value={playerUrl}
                        autoFocus
                        onChange={(e) => setPlayerUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handlePlayerUrlPlay();
                          if (e.key === "Escape") { setShowPlayerUrlInput(false); setPlayerUrl(""); }
                        }}
                        placeholder="Paste a video URL and press Enter…"
                        className="flex-1 rounded bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/40 outline-none focus:bg-white/20 focus:ring-1 focus:ring-blue-500"
                      />
                      <button
                        type="button"
                        onClick={handlePlayerUrlPlay}
                        className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                      >
                        Play
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowPlayerUrlInput(false); setPlayerUrl(""); }}
                        className="rounded p-1.5 text-white/60 hover:text-white hover:bg-white/10"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  {/* Progress Bar — hidden during live capture */}
                  {!isCapturing && (
                    <input
                      type="range"
                      min="0"
                      max={duration || 100}
                      value={currentTime}
                      onChange={handleSeek}
                      className="mb-3 w-full cursor-pointer accent-primary"
                      style={{
                        background: `linear-gradient(to right, rgb(59, 130, 246) 0%, rgb(59, 130, 246) ${
                          duration ? (currentTime / duration) * 100 : 0
                        }%, rgba(255, 255, 255, 0.3) ${
                          duration ? (currentTime / duration) * 100 : 0
                        }%, rgba(255, 255, 255, 0.3) 100%)`,
                      }}
                    />
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => skipTime(-10)}
                        className="rounded p-1.5 text-white transition-colors hover:bg-white/10"
                      >
                        <SkipBack className="h-5 w-5" />
                      </button>
                      <button
                        onClick={togglePlay}
                        className="rounded-full bg-blue-600 p-2.5 text-white transition-transform hover:scale-105 hover:bg-blue-700"
                      >
                        {isPlaying ? (
                          <Pause className="h-5 w-5" fill="currentColor" />
                        ) : (
                          <Play className="h-5 w-5" fill="currentColor" />
                        )}
                      </button>
                      <button
                        onClick={() => skipTime(10)}
                        className="rounded p-1.5 text-white transition-colors hover:bg-white/10"
                      >
                        <SkipForward className="h-5 w-5" />
                      </button>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={toggleMute}
                          className="rounded p-1.5 text-white transition-colors hover:bg-white/10"
                        >
                          {isMuted || volume === 0 ? (
                            <VolumeX className="h-5 w-5" />
                          ) : (
                            <Volume2 className="h-5 w-5" />
                          )}
                        </button>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={isMuted ? 0 : volume}
                          onChange={handleVolumeChange}
                          className="w-20 cursor-pointer accent-primary"
                        />
                      </div>

                      <span className="text-sm text-white">
                        {isCapturing ? (
                          <span className="flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                            LIVE
                          </span>
                        ) : (
                          `${formatTime(currentTime)} / ${formatTime(duration)}`
                        )}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setSubtitlesEnabled(!subtitlesEnabled)}
                        className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                          subtitlesEnabled
                            ? "bg-blue-600 text-white"
                            : "bg-white/10 text-white hover:bg-white/20"
                        }`}
                      >
                        <FileText className="inline h-4 w-4 mr-1" />
                        Subtitles
                      </button>

                      <div className="relative" ref={audioMenuRef}>
                        <button
                          onClick={() => setShowAudioMenu(!showAudioMenu)}
                          className="flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20"
                        >
                          {audioTrack === "english" && (
                            <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                          )}
                          Audio: {audioTrack === "english" ? "English" : "Original"}
                          <ChevronDown className="h-4 w-4" />
                        </button>
                        {showAudioMenu && (
                          <div className="absolute bottom-full right-0 mb-2 w-48 overflow-hidden rounded-lg border border-white/20 bg-[#1a1a1a] shadow-lg">
                            <button
                              onClick={() => selectAudioTrack("english")}
                              className={`w-full px-4 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                                audioTrack === "english" ? "bg-white/20 font-medium" : ""
                              }`}
                            >
                              English Dubbing (AI)
                            </button>
                            <button
                              onClick={() => selectAudioTrack("original")}
                              className={`w-full px-4 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                                audioTrack === "original" ? "bg-white/20 font-medium" : ""
                              }`}
                            >
                              Original Audio
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="relative" ref={playbackMenuRef}>
                        <button
                          onClick={() => setShowPlaybackMenu(!showPlaybackMenu)}
                          className="flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20"
                        >
                          {playbackRate}x
                          <ChevronDown className="h-4 w-4" />
                        </button>
                        {showPlaybackMenu && (
                          <div className="absolute bottom-full right-0 mb-2 w-32 overflow-hidden rounded-lg border border-white/20 bg-[#1a1a1a] shadow-lg">
                            {playbackRates.map((rate) => (
                              <button
                                key={rate}
                                onClick={() => setSpeed(rate)}
                                className={`w-full px-4 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                                  playbackRate === rate ? "bg-white/20 font-medium" : ""
                                }`}
                              >
                                {rate}x
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          setShowPlayerUrlInput((v) => !v);
                          setPlayerUrl("");
                        }}
                        title="Play from URL"
                        className={`rounded p-1.5 transition-colors ${
                          showPlayerUrlInput
                            ? "bg-blue-600 text-white"
                            : "text-white hover:bg-white/10"
                        }`}
                      >
                        <Link className="h-5 w-5" />
                      </button>

                      <button
                        onClick={toggleFullscreen}
                        className="rounded p-1.5 text-white transition-colors hover:bg-white/10"
                      >
                        <Maximize className="h-5 w-5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-6">
                <h2 className="mb-2 text-xl font-semibold">
                  {activeVideo.title}
                </h2>
                <div className="mb-4 flex items-center gap-4 text-sm text-muted-foreground">
                  <span>Original: {activeVideo.language}</span>
                  <span>•</span>
                  <span>Translated: English</span>
                  <span>•</span>
                  <span>Duration: {activeVideo.duration}</span>
                  <span>•</span>
                  <span className={`rounded-full px-2 py-0.5 ${
                    activeVideo.status === "ready"
                      ? "bg-green-100 text-green-700"
                      : "bg-yellow-100 text-yellow-700"
                  }`}>
                    {activeVideo.status === "ready" ? "Ready" : "Processing"}
                  </span>
                </div>
                {activeVideo.id === "1" && (
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Learn authentic French cooking techniques from Chef Marie Dubois
                    as she demonstrates classic recipes from her Parisian kitchen.
                    This masterclass covers everything from basic knife skills to
                    advanced sauce preparation.
                  </p>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
