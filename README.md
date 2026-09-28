# Altyazı Tərcüməçi – Gumroad (Chrome extension)

Gumroad kurslarındakı **ingiliscə altyazını** və ya **danışığı (səsi)** **Azərbaycan** və **Türk** dilinə tərcümə edir.

Əsas prinsip: **cümlə tam bitməyənə qədər tərcümə edilmir**. Altyazı hissələri (cue-lar) birləşdirilir, tam cümlə yığılır, sonra tərcümə olunur. Yarım cümlə tərcümə olunmadığı üçün məna itmir.

## Nə edir

| | |
|---|---|
| 📝 **Altyazı tərcüməsi** | Videonun ingiliscə altyazısını götürür (video track, pleyerin yüklədiyi `.vtt/.srt` faylı və ya ekrandakı yazı). Cümlələri tam yığır, tərcüməni **cümlə başlayan anda** göstərir. Bütün video arxa planda əvvəlcədən tərcümə olunur, ona görə geri/irəli çəkəndə gözləmə olmur. |
| 🎧 **Səs tərcüməsi** | Tabın səsini dinləyir, Whisper modeli ilə danışığı tanıyır (Amerika, Britaniya, Hind, Avstraliya və s. bütün aksentlər), **hər cümlə deyilib qurtaran kimi** tərcüməni göstərir. Altyazısı olmayan videolar üçün. |
| 🔠 Ölçü | `A−` / `A+` düymələri (altyazının üstünə siçanı gətirəndə görünür), popup-dakı slayder və ya **Alt+Shift+↑ / ↓**. |
| 🖥️ Full screen | Full screen-də yox olmur və avtomatik böyüyür (istəsəniz söndürə bilərsiniz). |
| ↕️ Yer | Altyazını siçanla yuxarı/aşağı sürüşdürün. |
| 📏 Sətirlər | Uzun cümlə bir uzun sətir olmur – "Sətir eni" ilə məhdudlaşır və bərabər sətirlərə bölünür. Əvvəlki 0–3 cümlə solğun rəngdə yuxarıda qalır ki, oxumağa çatdırasınız. |
| EN | İstəsəniz ingiliscə orijinal da kiçik hərflərlə altında görünür (**Alt+Shift+E**). |

## Quraşdırma

1. Bu repozitoriyanı yükləyin (`Code → Download ZIP`) və açın.
2. Chrome-da `chrome://extensions` açın, sağ yuxarıda **Developer mode**-u yandırın.
3. **Load unpacked** basın və `extension` qovluğunu seçin.
4. Gumroad-da kurs videosunu açın (əgər səhifə artıq açıq idisə – **yeniləyin**).

## İstifadə

### Altyazı tərcüməsi (pulsuz, açar lazım deyil)
1. Extension ikonuna basın → **📝 Altyazı tərcüməsi**, dili seçin (🇦🇿 / 🇹🇷).
2. Videonu oynadın. Popup-da "Video altyazısı tapıldı · N cümlə" yazılmalıdır.
3. Altyazı tapılmırsa, pleyerdə **CC** düyməsini bir dəfə yandırın.

### Səs tərcüməsi
1. Pulsuz Groq açarı alın: <https://console.groq.com/keys> (və ya OpenAI açarı).
2. Popup → **🎧 Səs tərcüməsi** → açarı yapışdırın → **▶ Başlat**.
3. Video oynadıqca hər cümlə bitəndə tərcümə görünür (≈1–2 saniyə gecikmə ilə).

### Daha yaxşı tərcümə keyfiyyəti (istəyə görə)
Standart olaraq pulsuz Google Translate işləyir. **Claude AI** seçib Anthropic API açarı daxil etsəniz, tərcümə kontekstə baxaraq edilir: danışıq dili, idiomlar, texniki terminlər (məs. *Shader Editor*, *Area light*) daha təbii və düzgün olur. Claude xəta versə avtomatik Google-a keçir.

## Qısayollar

| Qısayol | Nə edir |
|---|---|
| Alt+Shift+↑ / ↓ | Yazını böyüt / kiçilt |
| Alt+Shift+E | İngiliscə orijinalı göstər / gizlət |
| Alt+Shift+L | Dili dəyiş (AZ ↔ TR) |
| Alt+Shift+S | Aktiv / deaktiv |

## Necə işləyir (texniki)

- `extension/lib/sentences.js` – cümlə yığma: cue-ları birləşdirir, təkrarlanan ("rolling") altyazıları təmizləyir, qısaltmaları (`Dr.`, `e.g.`, `3.5`) cümlə sonu saymır, çox uzun durğu işarəsiz mətni vergüldən bölür. Canlı rejimdə Whisper-in vaxtsız qoyduğu nöqtəni ("connect the.") tanıyıb növbəti hissə ilə birləşdirir.
- `extension/content/page-hook.js` – pleyerin (Gumroad JW Player istifadə edir) özü yüklədiyi altyazı faylını tutur.
- `extension/content/content.js` – videonu tapır, altyazı mənbəyini seçir, tərcüməni Shadow DOM overlay-də göstərir, full screen-i idarə edir.
- `extension/offscreen/` – səs rejimi: tab səsini tutur, pauzalara görə kəsir, Whisper-ə göndərir.
- `extension/lib/translate.js` – Google (pulsuz) və Claude tərcümə.

API açarları yalnız sizin brauzerinizdə (`chrome.storage.local`) saxlanılır və yalnız müvafiq API-yə göndərilir.

## Testlər

```bash
npm test          # cümlə məntiqi, tərcümə, səs pipeline
npm run test:e2e  # Chromium-da extension-ı yükləyib real overlay-i yoxlayır (Playwright lazımdır)
```
