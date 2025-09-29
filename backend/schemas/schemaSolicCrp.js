// schemas/schemaSolicCrp.js
import { z } from "zod";

export const schemaSolicCrp = z.object({
  // Gate (informativo)
  HAS_TERMO_ENC_GESCON: z.boolean().optional(),
  N_GESCON: z.string().optional().nullable(),
  DATA_ENC_VIA_GESCON: z.string().optional().nullable(),

  // 1) Ente / UG
  ESFERA: z.enum(["RPPS Municipal","Estadual/Distrital"]),
  UF: z.string().min(2),
  ENTE: z.string().min(2),
  CNPJ_ENTE: z.string().min(14).max(14),
  EMAIL_ENTE: z.string().email(),

  UG: z.string().min(1),
  CNPJ_UG: z.string().min(14).max(14),
  EMAIL_UG: z.string().email(),

  // 2) Representantes
  CPF_REP_ENTE: z.string().min(11).max(11),
  NOME_REP_ENTE: z.string().min(2),
  CARGO_REP_ENTE: z.string().min(1),
  EMAIL_REP_ENTE: z.string().email(),
  TEL_REP_ENTE: z.string().optional().nullable(),

  CPF_REP_UG: z.string().min(11).max(11),
  NOME_REP_UG: z.string().min(2),
  CARGO_REP_UG: z.string().min(1),
  EMAIL_REP_UG: z.string().email(),
  TEL_REP_UG: z.string().optional().nullable(),

  // 3) CRP anterior
  DATA_VENCIMENTO_ULTIMO_CRP: z.string().min(1),
  TIPO_EMISSAO_ULTIMO_CRP: z.enum(["Administrativa","Judicial"]),
  CRITERIOS_IRREGULARES: z.array(z.string()).optional().default([]),

  // 4) Fase
  FASE_PROGRAMA: z.enum(["4.1","4.2","4.3","4.4","4.5","4.6"]),

  // 4.1
  F41_OPCAO: z.string().optional().default(""),

  // 4.2
  F42_LISTA: z.array(z.string()).optional().default([]),

  // 4.3
  F43_LISTA: z.array(z.string()).optional().default([]),
  F43_JUST: z.string().optional().default(""),
  F43_PLANO: z.string().optional().default(""),

  // 4.4
  F44_CRITERIOS: z.array(z.string()).optional().default([]),
  F44_DECLS: z.array(z.string()).optional().default([]),
  F44_FINALIDADES: z.array(z.string()).optional().default([]),
  F44_ANEXOS: z.string().optional().default(""),

  // 4.5
  F45_OK451: z.boolean().optional().default(false),
  F45_DOCS: z.string().optional().default(""),
  F45_JUST: z.string().optional().default(""),

  // 4.6
  F46_CRITERIOS: z.array(z.string()).optional().default([]),
  F46_PROGESTAO: z.string().optional().default(""),
  F46_PORTE: z.string().optional().default(""),
  F46_JUST_D: z.string().optional().default(""),
  F46_DOCS_D: z.string().optional().default(""),
  F46_JUST_E: z.string().optional().default(""),
  F46_DOCS_E: z.string().optional().default(""),
  F46_FINALIDADES: z.array(z.string()).optional().default([]),
  F46_ANEXOS: z.string().optional().default(""),
  F46_JUST_PLANOS: z.string().optional().default(""),
  F46_COMP_CUMPR: z.string().optional().default(""),

  // 5) Justificativas gerais
  JUSTIFICATIVAS_GERAIS: z.string().optional().default(""),

  // Carimbos
  MES: z.string().min(1),
  DATA_SOLIC_GERADA: z.string().min(1),
  HORA_SOLIC_GERADA: z.string().min(1),
  ANO_SOLIC_GERADA: z.string().min(4),

  // Idempotência
  IDEMP_KEY: z.string().optional().default(""),
});
