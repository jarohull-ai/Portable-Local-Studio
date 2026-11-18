# Polski lektor — skąd głosy i co z tego wyszło

Robocze notatki z dobierania polskiego głosu TTS do studia. Nie jest to dokumentacja
funkcji (tę opisuje README), tylko zapis: które modele sprawdziliśmy, skąd pochodzą,
co zostało w kodzie i co świadomie odrzuciliśmy.

Data: 2026-11-18. Wybór: **Piper `pl_PL-bass-high`** jako domyślny lektor PL.

---

## 1. Skąd pochodzą głosy

Wszystkie głosy Piper pochodzą z jednego repozytorium: **`rhasspy/piper-voices`**
na Hugging Face — <https://huggingface.co/rhasspy/piper-voices>.
To oficjalne wydanie głosów do Pipera (format ONNX + `*.onnx.json` z metadanymi).
Serwer pobiera pliki bezpośrednio z
`https://huggingface.co/rhasspy/piper-voices/resolve/main/<ścieżka>`.

| Głos | Ścieżka w repo HF | Rozmiar | Jakość | Próbkowanie | Licencja |
|---|---|---|---|---|---|
| Gosia (`pl_gosia`) | `pl/pl_PL/gosia/medium` | 63 MB | medium | 22 050 Hz | CC0 |
| Darkman (`pl_darkman`) | `pl/pl_PL/darkman/medium` | 63 MB | medium | 22 050 Hz | CC0 |
| **Bass (`pl_bass`)** | `pl/pl_PL/bass/high` | 114 MB | **high** | 22 050 Hz | **Apache 2.0** |
| MC Speech (`pl_mc_speech`) | `pl/pl_PL/mc_speech/medium` | 63 MB | medium | 22 050 Hz | CC0 |
| MLS 6892 (`pl_mls_6892`) | `pl/pl_PL/mls_6892/low` | 63 MB | low | 16 000 Hz | CC BY 4.0 |

### Bass — pełna metryka (to on zostaje)

Model card `pl/pl_PL/bass/high/MODEL_CARD`:

> Polish (pl_PL) male voice, high quality.
> Fine-tuned from **en_US-lessac-high** on ~10 000 segments of Polish speech.

- mówca: mężczyzna, jeden mówca, polski
- trening: dotrenowanie angielskiego głosu `lessac` (high) na ~10 000 segmentów mowy polskiej
- licencja: **Apache 2.0** (najbardziej liberalna z całej piątki — można używać komercyjnie
  i nie wymaga podawania autorstwa w nagraniach)
- 22 050 Hz, mono, pliki: `pl_PL-bass-high.onnx` (114 MB) + `.onnx.json` (4,9 KB)
- sample autora: <https://huggingface.co/blackbartblues/piper-pl-bass-high>

Pozostałe:

- **Gosia / Darkman** — `medium`, CC0, dotrenowane z angielskiego `lessac-medium`.
  Dane: <https://github.com/OHF-Voice/voice-datasets>.
- **MC Speech** — `medium`, CC0, dotrenowany z `lessac-medium`; dane z Kaggle
  `czyzi0/the-mc-speech-dataset`.
- **MLS 6892** — `low`, 16 kHz, CC BY 4.0 (wymaga podania autorstwa przy redystrybucji),
  dotrenowany z angielskiego `ryan-low`; dane: <http://www.openslr.org/94/>.

## 2. Jak te głosy trafiają na dysk

- pliki leżą w `app/tts-models/piper/` (katalog ignorowany przez git — modele nie idą do repo)
- instaluje je `scripts/setup/setup-piper.sh` (wołany z `setup-tts.sh`, poza macOS)
- pojedynczy głos można dobrać w aplikacji: **Models → Voice → „Piper voices (Polish, offline)"**
  → `POST /api/tts/download-model` z `{"model": "pl_bass"}`; serwer pobiera `.onnx`
  i `.onnx.json`, pomija pliki już obecne, zapisuje przez `.part` i przemianowuje
- wybór głosu w zakładce Voice, np. `"voice": "pl_bass"` w `POST /api/tts/speak`

## 3. Co działa dobrze

- **Bass jako lektor** — po odsłuchu: „prawie perfekcyjny", zostaje jako głos domyślny.
  Do tego Apache 2.0, więc bez ograniczeń licencyjnych przy publikacji nagrań.
- **Pobieranie w aplikacji** — działa dla wszystkich trzech nowych głosów; po pobraniu
  karta pokazuje „Downloaded", a głos od razu pojawia się w zakładce Voice.
- **Piper jako silnik** — bardzo szybki na CPU, niskie zużycie RAM, deterministyczne
  czasy (3,3 s mowy = ~3,3 s generowania), zero konfiguracji GPU.
- **Pipeline OpenVoice V2** (`scripts/workers/tts-voiceconv.py`, głosy `pl_george`
  i `pl_george_soft`) — podmiana barwy na wyjściu Pipera działa; daje warianty
  „ciemniejszy" i „miękki" z jednego modelu bazowego.
- **Bramka `tame_tails()`** — wygładzanie końcówek zdań. Zmierzone wtedy wartości
  (metryka długości ogonków, im mniej tym lepiej): Kokoro referencja 22,2;
  surowy Piper 35,4; bramka mocna 20,5; bramka łagodna 25,0; podobieństwo barwy 0,915.
  Została wersja łagodna (0,20 / 0,45 / 0,25) — mocna brzmiała sztucznie.

## 4. Co jest tylko OK

- **Gosia / Darkman** — poprawna dykcja, dobre do testów i jako baza dla OpenVoice,
  ale barwa wyraźnie „syntetyczna"; przy Bassie wypadają blado.
- **MC Speech** — równy, neutralny głos, ale bez charakteru; przydatny jako zapas.
- **MLS 6892** — najsłabszy: 16 kHz i jakość `low`, słyszalne szumy i mniejsze
  opanowanie polskich końcówek. Nadaje się tylko do szybkich prób.
- **Interpunkcja i akcent zdaniowy** — Piper czyta poprawnie, ale prozodia jest płaska:
  brak akcentowania emocji, pytania brzmią jak twierdzenia. Da się to łagodzić
  przecinkami i krótszymi zdaniami, nie da się ustawić „na życzenie".

## 5. Co nie działa / zostało odrzucone

- **Brak normalizacji tekstu przed syntezą.** Studio nie ma etapu normalizacji, więc
  liczby, daty, skróty („np.", „itd.", „2026 r.") i symbole są czytane dosłownie albo
  przekręcane. To największa pojedyncza wada obecnego lektora — do nadrobienia
  osobnym krokiem (normalizator tekstu), nie zmianą głosu.
- **XTTS-v2** — odrzucony: licencja CPML (ograniczenia komercyjne) i słabsza jakość
  polskiej wymowy niż Piper high.
- **OmniVoice** — odrzucony: 6,1 GB modelu i RTF ≈ 4 na CPU (czyli ~4 s liczenia na
  sekundę mowy) — nie do użycia w tym studiu.
- **Silero, MeloTTS, Zonos, Dia, CosyVoice3, Qwen3-TTS** — brak polskiego wsparcia
  (albo polski jest tylko teoretycznie na liście języków, bez wytrenowanego mówcy).
- **MMS-TTS pol (`facebook/mms-tts-pol`)** — 145 MB, licencja CC-BY-NC (zakaz użycia
  komercyjnego) i jakość poniżej Pipera; świadomie **nie został wdrożony**.
- **Chatterbox Multilingual v3** — teoretycznie ma polski (23 języki, MIT), ale projekt
  został zarchiwizowany w VIII 2026; są buildy ONNX/GGUF, nie testowaliśmy.
- **LFM3-Omni-2B** — 1,1 GB + 292 MB mmproj, RTF ≈ 0,47 na CPU, ale wymaga
  llama.cpp ≥ 0.8 z obsługą TTS, a backend w projekcie to 0.5.0-dev (brak `--tts-lang`).
  Czyli: nie da się uruchomić bez wymiany backendu.
- **OpenVoice nie naprawia wymowy** — zmienia tylko barwę. Jeśli Piper źle przeczyta
  słowo, `pl_george` przeczyta je tak samo źle.

## 6. Otwarte tematy

1. Normalizacja tekstu (liczby, daty, skróty) przed Piperem — największy zysk jakości.
2. Ewentualne porównanie Chatterbox vs LFM3-Omni, jeśli któryś da się uruchomić
   bez wymiany backendu.
3. `mc_speech` i `mls_6892` nie mają w model card informacji o płci mówcy — w UI
   pokazują się bez etykiety płci (celowo, zamiast zgadywania).
