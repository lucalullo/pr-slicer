# Piano PR Slicer

**Modifica singola**

Base: `00eeba4235fc0d737dee3633061cbf786cbab302`  
Head: `219fdd75d0d87c8f43e644161523b65f7564b991`

## Fatti osservati

- 2 file, 2 unità, 1 relazioni.
- Ricostruzione finale identica al tree head: `cb3559bb54a65cbeaa3756f43d0be0f8d0776219`.
- Analisi: deep.

## Gruppi e inferenze strutturali

### 1. Aggiungi consumer.ts (2 file)

ID: `slice_3c5b45603b62a5b3` · 2 file · +3/−0

Dipendenze: nessuna

- consumer.ts
- types.ts

- Segmento contiguo di un ordine che rispetta le dipendenze note; dimensione, package, aree e affinità determinano il costo.

## Verifiche eseguite

Stato: **not-run** · livello: **reconstructed**

| Gruppo | Controllo | Esito | Dettaglio |
|---|---|---|---|
| — | Ricostruzione finale | passed | Build, test e diagnostica dei prefissi non eseguiti |

## Metriche

| Metrica | Valore |
|---|---|
| Revisionabilità | 66.67/100 |
| Coesione strutturale | 100/100 |
| Integrità dipendenze | 100/100 |
| Confidenza dei confini | medium |

Le metriche sono euristiche strutturali, non probabilità di correttezza.

## Alternative statiche

- `candidate_b2c926bb6eec887d`: 1 gruppi, costo 16.75.
- `candidate_c3cc5412445a64d6`: 2 gruppi, costo 25.5.

## Limiti e incertezze


Il superamento dei controlli non dimostra la correttezza assoluta del comportamento.
