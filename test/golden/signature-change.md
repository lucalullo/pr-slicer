# Piano PR Slicer

**Modifica singola**

Base: `ba3c508aee22a95397d6b3616bbce9f5e84ef2ab`  
Head: `dac29bea70bc05f45177615ec6b1f21f6322f46e`

## Fatti osservati

- 2 file, 2 unità, 1 relazioni.
- Ricostruzione finale identica al tree head: `ba3fb7f37d8cccd0ed9db333320fa91fa94d8ca5`.
- Analisi: deep.

## Gruppi e inferenze strutturali

### 1. Aggiorna a.ts (2 file)

ID: `slice_b578ebd8f83278af` · 2 file · +2/−2

Dipendenze: nessuna

- a.ts
- b.ts

- a.ts#api changes its signature; affected changed consumers remain in the same slice.

## Verifiche eseguite

Stato: **not-run** · livello: **reconstructed**

| Gruppo | Controllo | Esito | Dettaglio |
|---|---|---|---|
| — | Ricostruzione finale | passed | Build, test e diagnostica dei prefissi non eseguiti |

## Metriche

| Metrica | Valore |
|---|---|
| Revisionabilità | 50/100 |
| Coesione strutturale | 100/100 |
| Integrità dipendenze | 100/100 |
| Confidenza dei confini | medium |

Le metriche sono euristiche strutturali, non probabilità di correttezza.

## Alternative statiche

- `candidate_0605800ca1cb7efd`: 1 gruppi, costo 43.

## Limiti e incertezze


Il superamento dei controlli non dimostra la correttezza assoluta del comportamento.
