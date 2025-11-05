// schemas/schemaSolicCrp.js
import { z } from "zod";

const zStr = z.string().optional().default("");
const zYesBlank = z.enum(["SIM",""]).optional().default("");

export const schemaSolicCrp = z.object({
  // Gate (informativo)
  HAS_TERMO_ENC_GESCON: z.boolean().optional(),
  N_GESCON: z.string().optional().nullable(),
  DATA_ENC_VIA_GESCON: z.string().optional().nullable(),
  SEI_PROCESSO: z.string().optional().default(""),

  // 1) Ente / UG
  ESFERA: z.enum(["RPPS Municipal","Estadual/Distrital"]),
  UF: z.string().min(2),
  ENTE: z.string().min(2),
  CNPJ_ENTE: z.string().min(14).max(14),
  EMAIL_ENTE: z.string().email(),

  UG: z.string().min(1),
  CNPJ_UG: z.string().min(14).max(14),
  EMAIL_UG: z.string().email(),
  ORGAO_VINCULACAO_UG: zStr,

  // 2) Representantes
  CPF_REP_ENTE: z.string().min(11).max(11),
  NOME_REP_ENTE: z.string().min(2),
  CARGO_REP_ENTE: z.string().min(1),
  EMAIL_REP_ENTE: z.string().email(),
  TEL_REP_ENTE: z.string().optional().default("").nullable(),

  CPF_REP_UG: z.string().min(11).max(11),
  NOME_REP_UG: z.string().min(2),
  CARGO_REP_UG: z.string().min(1),
  EMAIL_REP_UG: z.string().email(),
  TEL_REP_UG: z.string().optional().default("").nullable(),

  // 3) CRP anterior (opcionais aqui)
  DATA_VENC_ULTIMO_CRP: zStr,                       // 3.1 (front envia dd/mm/aaaa ou ISO)
  DATA_VENCIMENTO_ULTIMO_CRP: zStr,                 // alias
  TIPO_EMISSAO_ULTIMO_CRP: z.enum(["Administrativa","Judicial"]).optional().or(z.literal("")).default(""),
  CRITERIOS_IRREGULARES: z.array(z.string()).optional().default([]),

  // 3.2 — Finalidades
  ADESAO_SEM_IRREGULARIDADES: zYesBlank,
  FIN_3_2_MANUTENCAO_CONFORMIDADE: zYesBlank,
  FIN_3_2_DEFICIT_ATUARIAL: zYesBlank,
  FIN_3_2_CRITERIOS_ESTRUTURANTES: zYesBlank,
  FIN_3_2_OUTRO_CRITERIO_COMPLEXO: zYesBlank,

  // 4) Fase
  FASES_MARCADAS: z.array(z.enum(["4.1","4.2","4.3","4.4","4.5","4.6"])).optional().default([]),
  FASE_PROGRAMA: z.enum(["4.1","4.2","4.3","4.4","4.5","4.6"]),

  // 4.1
  F41_OPCAO: zStr, // "4.1.1" ou "4.1.2"

  // 4.2
  F42_LISTA: z.array(z.string()).optional().default([]),

  // 4.3
  F43_LISTA: z.array(z.string()).optional().default([]),
  F43_JUST: zStr,
  F43_PLANO: zStr,
  F43_PLANO_B: zStr,
  F43_DESC_PLANOS: zStr,
  F4310_OPCAO: z.enum(["A","B"]).optional().or(z.literal("")).default(""),
  F4310_LEGISLACAO: zStr,
  F4310_DOCS: zStr,
  F43_INCLUIR: z.array(z.string()).optional().default([]),

  // 4.4
  F44_CRITERIOS: z.array(z.string()).optional().default([]),
  F44_DECLS: z.array(z.string()).optional().default([]),
  F44_FINALIDADES: z.array(z.string()).optional().default([]),
  F44_ANEXOS: zStr,
  F441_LEGISLACAO: zStr,
  F445_DESC_PLANOS: zStr,
  F446_DOCS: zStr,
  F446_EXEC_RES: zStr,

  // 4.5
  F45_OK451: z.boolean().optional().default(false),
  F45_DOCS: zStr,
  F45_JUST: zStr,
  F453_EXEC_RES: zStr,

  // 4.6
  F46_CRITERIOS: z.array(z.string()).optional().default([]),
  F46_PROGESTAO: zStr,
  F46_PORTE: zStr,
  F46_JUST_D: zStr,
  F46_DOCS_D: zStr,
  F46_JUST_E: zStr,
  F46_DOCS_E: zStr,
  F46_FINALIDADES: z.array(z.string()).optional().default([]),
  F46_ANEXOS: zStr,
  F46_JUST_PLANOS: zStr,
  F46_COMP_CUMPR: zStr,
  F462F_CRITERIOS: z.array(z.string()).optional().default([]),
  F466_DOCS: zStr,
  F466_EXEC_RES: zStr,

  // 5) Justificativas gerais
  JUSTIFICATIVAS_GERAIS: zStr,

  // Carimbos
  MES: z.string().min(1),
  DATA_SOLIC_GERADA: z.string().min(1),
  HORA_SOLIC_GERADA: z.string().min(1),
  ANO_SOLIC_GERADA: z.string().min(4),

  // Idempotência
  IDEMP_KEY: z.string().optional().default(""),

  // Prazo adicional (3.4) — os campos entram no payload final via buildPayload
  PRAZO_ADICIONAL_COD: zStr,
  PRAZO_ADICIONAL_TEXTO: zStr,

  // === [PATCH] Compat: aceitar todos os campos detalhados do Item 4 (nomes "fase4_*") ===
  // 4.1
  fase4_1_criterios:            z.array(z.string()).optional().default([]),
  fase4_1_criterios_outros:     zStr,
  fase4_1_declaracao_base:      zStr, // "Sim"/"Não"
  fase4_1_decl_a_data:          zStr,
  fase4_1_decl_b_conf:          z.array(z.string()).optional().default([]),
  fase4_1_decl_f:               z.array(z.string()).optional().default([]),
  fase4_1_finalidade:           z.array(z.string()).optional().default([]),
  fase4_1_finalidade_protocolos:z.array(z.string()).optional().default([]),
  fase4_1_anexos:               z.array(z.string()).optional().default([]),
  fase4_1_anexos_desc:          z.array(z.string()).optional().default([]),
  fase4_1_just:                 zStr,
  fase4_1_comp_tipo:            zStr,
  fase4_1_comp_protocolo:       zStr,
  fase4_1_comp_data:            zStr,

  // 4.2
  fase4_2_criterios:            z.array(z.string()).optional().default([]),
  fase4_2_decl:                 zStr,
  fase4_2_decl_a_lei:           zStr,
  fase4_2_decl_b_prazo:         zStr,
  fase4_2_decl_f:               z.array(z.string()).optional().default([]),
  fase4_2_finalidade:           zStr, // select
  fase4_2_prazo_req:            zStr,
  fase4_2_prazo_fund:           zStr,
  fase4_2_anexos:               z.array(z.string()).optional().default([]),
  fase4_2_anexos_desc:          z.array(z.string()).optional().default([]),
  fase4_2_just:                 zStr,
  fase4_2_comp_tipo:            zStr,
  fase4_2_comp_num:             zStr,
  fase4_2_comp_data:            zStr,

  // 4.3
  fase4_3_escopo:               z.array(z.string()).optional().default([]),
  fase4_3_eq_massa_alvo:        z.array(z.string()).optional().default([]),
  fase4_3_eq_crono:             zStr,
  fase4_3_eq_indicadores:       z.array(z.string()).optional().default([]),
  fase4_3_eq_indicadores_outros:zStr,
  fase4_3_decl:                 zStr,
  fase4_3_decl_a_param:         zStr,
  fase4_3_decl_f:               z.array(z.string()).optional().default([]),
  fase4_3_finalidade:           z.array(z.string()).optional().default([]),
  fase4_3_alt_detalhe:          zStr,
  fase4_3_anexos:               z.array(z.string()).optional().default([]),
  fase4_3_anexos_desc:          z.array(z.string()).optional().default([]),
  fase4_3_just:                 zStr,
  fase4_3_comp_tipo:            zStr,
  fase4_3_comp_num:             zStr,
  fase4_3_comp_data:            zStr,

  // 4.4
  fase4_4_debitos_massa:        z.array(z.string()).optional().default([]),
  fase4_4_debitos_outros:       zStr,
  fase4_4_vinc_fpm:             zStr,
  fase4_4_vinc_lei:             zStr,
  fase4_4_vinc_proc:            zStr,
  fase4_4_comp_tipo:            zStr,
  fase4_4_comp_dipr_num:        zStr,
  fase4_4_comp_dipr_data:       zStr,
  fase4_4_anexos:               z.array(z.string()).optional().default([]),
  fase4_4_anexos_desc:          z.array(z.string()).optional().default([]),
  fase4_4_just:                 zStr,
  fase4_4_comp_final_tipo:      zStr,
  fase4_4_comp_final_num:       zStr,
  fase4_4_comp_final_data:      zStr,

  // 4.5
  fase4_5_criterios:            z.array(z.string()).optional().default([]),
  fase4_5_decl:                 zStr,
  fase4_5_decl_a_dtcrp_ult:     zStr,
  fase4_5_decl_b_tipo:          zStr,
  fase4_5_decl_f:               z.array(z.string()).optional().default([]),
  fase4_5_finalidade:           z.array(z.string()).optional().default([]),
  fase4_5_crp_info:             zStr,
  fase4_5_anexos:               z.array(z.string()).optional().default([]),
  fase4_5_anexos_desc:          z.array(z.string()).optional().default([]),
  fase4_5_just:                 zStr,
  fase4_5_comp_tipo:            zStr,
  fase4_5_comp_num:             zStr,
  fase4_5_comp_data:            zStr,

  // 4.6
  fase4_6_criterios_plano:      z.array(z.string()).optional().default([]),
  fase4_6_pg_nivel:             zStr,
  fase4_6_criterios_outros:     zStr,
  fase4_6_declaracoes:          zStr,
  fase4_6_decl_a_base:          zStr,
  fase4_6_decl_b_conferencia:   z.array(z.string()).optional().default([]),
  fase4_6_crit_f:               z.array(z.string()).optional().default([]),
  fase4_6_finalidade:           z.array(z.string()).optional().default([]),
  fase4_6_alt_crono:            zStr,
  fase4_6_alt_kpi:              z.array(z.string()).optional().default([]),
  fase4_6_prazo_data:           zStr,
  fase4_6_prazo_fund:           zStr,
  fase4_6_anexos:               z.array(z.string()).optional().default([]),
  fase4_6_anexos_desc:          z.array(z.string()).optional().default([]),
  fase4_6_anexos_tipo:          zStr,
  fase4_6_anexos_ref:           zStr,
  fase4_6_just:                 zStr,
  fase4_6_comp:                 zStr,
  fase4_6_comp_kpi:             z.array(z.string()).optional().default([]),
  fase4_6_comp_kpi_arq:         z.array(z.string()).optional().default([]),
  fase4_6_comp_num:             zStr,
  fase4_6_comp_data:            zStr,



})


.superRefine((data, ctx) => {
  const fase = data.FASE_PROGRAMA;

  if (fase === "4.1") {
    if (!data.F41_OPCAO?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["F41_OPCAO"], message: "Na fase 4.1, selecione 4.1.1 ou 4.1.2." });
    }
  }

  if (fase === "4.2") {
    if (!data.F42_LISTA || data.F42_LISTA.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["F42_LISTA"], message: "Na fase 4.2, marque ao menos um item (a–i)." });
    }
  }

  if (fase === "4.3") {
    const algoPreenchido =
      (data.F43_LISTA && data.F43_LISTA.length > 0) ||
      (data.F43_PLANO && data.F43_PLANO.trim() !== "") ||
      (data.F43_PLANO_B && data.F43_PLANO_B.trim() !== "") ||
      (data.F43_DESC_PLANOS && data.F43_DESC_PLANOS.trim() !== "") ||
      (data.F43_INCLUIR && data.F43_INCLUIR.length > 0) ||
      (data.F43_JUST && data.F43_JUST.trim() !== "");
    if (!algoPreenchido) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["F43_LISTA"], message: "Na fase 4.3, marque ao menos um critério ou descreva/justifique no(s) campo(s) disponível(is)." });
    }
  }

  if (fase === "4.4") {
    const finalidadeE = (data.F44_FINALIDADES || []).some(f =>
      /Organização do RPPS.*critério estruturante/i.test(f)
    );
    if (finalidadeE && (!data.F44_CRITERIOS || data.F44_CRITERIOS.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["F44_CRITERIOS"], message: "Na 4.4, ao marcar a finalidade “e)”, selecione pelo menos um critério em 4.4.3." });
    }
  }

  if (fase === "4.5") {
    const algum =
      !!data.F45_OK451 ||
      (data.F45_DOCS && data.F45_DOCS.trim() !== "") ||
      (data.F45_JUST && data.F45_JUST.trim() !== "") ||
      (data.F453_EXEC_RES && data.F453_EXEC_RES.trim() !== "");
    if (!algum) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["F45_OK451"], message: "Na fase 4.5, marque 4.5.1 ou preencha documentos/justificativas/execução." });
    }
  }

  if (fase === "4.6") {
    if (!data.F46_CRITERIOS || data.F46_CRITERIOS.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["F46_CRITERIOS"], message: "Na fase 4.6, selecione ao menos um critério em 4.6.1." });
    }
    if (!data.F46_PROGESTAO?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["F46_PROGESTAO"], message: "Informe o nível Pró-Gestão em 4.6.1 (b)." });
    }
    if (!data.F46_PORTE?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["F46_PORTE"], message: "Informe o Porte ISP-RPPS em 4.6.1 (c)." });
    }
  }
});
