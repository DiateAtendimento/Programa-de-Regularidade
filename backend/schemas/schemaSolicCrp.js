// schemas/schemaSolicCrp.js
import { z } from "zod";

/* =========================
   Helpers e constantes
   ========================= */
const zStr = z.string().optional().default("");
const zYesBlank = z.enum(["SIM", ""]).optional().default("");

// Aceita string, array de strings, null/undefined → sempre array<string>
const zArrStr = z
  .preprocess((v) => {
    if (Array.isArray(v)) return v.filter((x) => x != null && String(x).trim() !== "").map(String);
    if (v == null) return [];
    const s = String(v).trim();
    if (!s) return [];
    // separa por ; , ou quebra de linha
    return s.split(/[;,]\s*|\r?\n/).map((x) => x.trim()).filter(Boolean);
  }, z.array(z.string()))
  .optional()
  .default([]);

/** Opções textuais (labels) frequentemente usadas no front.
 *  As validações aceitam "qualquer string", mas exportamos para uso na UI. */
export const F42_OPCOES = [
  "DIPR – Encaminhamento",
  "DIPR - Consistência e Caráter Contributivo",
  "Caráter contributivo - Repasse (objeto de PAP)",
  "Utilização dos recursos previdenciários (objeto de PAP)",
  "Aplicações Financeiras Resol. CMN - Adequação DAIR e Política Investimentos (objeto de PAP) (pós-adesão)",
  "DAIR – Encaminhamento",
  "DAIR - Consistência (pós-adesão)",
  "DPIN – Encaminhamento",
  "DPIN – Consistência (pós-adesão)",
];

export const CRITERIOS_1_22 = [
  "Atendimento à solicitação de legislação, documentos ou informações pela Secretaria de Regime Próprio e Complementar",
  "Aplicações Financeiras Resol. CMN - Adequação DAIR e Política Investimentos (objeto de PAP)",
  "Atendimento à fiscalização",
  "Caráter contributivo - Repasse (objeto de Processo Administrativo Previdenciário)",
  "Demonstrativo da Política de Investimentos - DPIN – Consistência",
  "Demonstrativo da Política de Investimentos - DPIN – Encaminhamento",
  "Demonstrativo das Aplicações e Investimentos dos Recursos - DAIR – Consistência",
  "Demonstrativo das Aplicações e Investimentos dos Recursos - DAIR – Encaminhamento",
  "Demonstrativo de Informações Previdenciárias e Repasses - DIPR - Consistência e Caráter Contributivo",
  "Demonstrativo de Informações Previdenciárias e Repasses - DIPR – Encaminhamento",
  "Envio da Matriz de Saldos Contábeis (MSC) por meio do Siconfi",
  "Equilíbrio Financeiro e Atuarial - Encaminhamento NTA, DRAA e resultados das análises",
  "Existência e funcionamento de unidade gestora e regime próprio únicos",
  "Filiação ao RPPS e regras de concessão, cálculo e reajustamento dos benefícios, nos termos do art. 40 da Constituição Federal",
  "Instituição do regime de previdência complementar - Aprovação da lei",
  "Instituição do regime de previdência complementar – Aprovação e operacionalização do convênio de adesão",
  "Observância dos limites de contribuição do ente",
  "Observância dos limites de contribuição dos segurados e beneficiários",
  "Operacionalização da compensação previdenciária – Termo de Adesão e Contrato com a empresa de tecnologia",
  "Plano de benefícios integrado apenas por aposentadorias e pensões por morte",
  "Requisitos para dirigentes, membros titulares dos conselhos deliberativo e fiscal e do comitê de investimentos do RPPS",
  "Utilização dos recursos previdenciários (objeto de PAP)",
];
/* =========================
   Schema principal
   ========================= */
export const schemaSolicCrp = z
  .object({
    // Gate (informativo)
    HAS_TERMO_ENC_GESCON: z.boolean().optional(),
    N_GESCON: z.string().optional().nullable(),
    DATA_ENC_VIA_GESCON: z.string().optional().nullable(),
    SEI_PROCESSO: z.string().optional().default(""),

    // 1) Ente / UG
    ESFERA: z.enum(["RPPS Municipal", "Estadual/Distrital"]),
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
    DATA_VENC_ULTIMO_CRP: zStr, // 3.1
    DATA_VENCIMENTO_ULTIMO_CRP: zStr, // alias
    TIPO_EMISSAO_ULTIMO_CRP: z
      .enum(["Administrativa", "Judicial"])
      .optional()
      .or(z.literal(""))
      .default(""),
    CRITERIOS_IRREGULARES: zArrStr, // 3.3

    // 3.2 — Finalidades (legado)
    ADESAO_SEM_IRREGULARIDADES: zYesBlank,
    FIN_3_2_MANUTENCAO_CONFORMIDADE: zYesBlank,
    FIN_3_2_DEFICIT_ATUARIAL: zYesBlank,
    FIN_3_2_CRITERIOS_ESTRUTURANTES: zYesBlank,
    FIN_3_2_OUTRO_CRITERIO_COMPLEXO: zYesBlank,

    // 3.4 — Prazo adicional (compat c/ template)
    PRAZO_ADICIONAL_COD: zStr, // esperado "3.4.1".."3.4.4" (mas aceitamos livre)
    PRAZO_ADICIONAL_TEXTO: zStr,

    // 4) Fase
    FASES_MARCADAS: z.array(z.enum(["4.1", "4.2", "4.3", "4.4", "4.5", "4.6"])).optional().default([]),
    FASE_PROGRAMA: z.enum(["4.1", "4.2", "4.3", "4.4", "4.5", "4.6"]),

    // 4.1
    F41_OPCAO: zStr, // "4.1.1" ou "4.1.2"

    // 4.2
    F42_LISTA: zArrStr, // lista a–i (labels livres)

    // 4.3 — blocos padrão
    F43_LISTA: zArrStr,
    F43_JUST: zStr,
    F43_PLANO: zStr, // 4.3.11 — Inclusões sugeridas
    F43_PLANO_B: zStr, // compat
    F43_DESC_PLANOS: zStr, // compat
    F4310_OPCAO: z.enum(["A", "B"]).optional().or(z.literal("")).default(""),
    F4310_LEGISLACAO: zStr,
    F4310_DOCS: zStr,
    F43_INCLUIR: zArrStr, // 4.3.12(a) — critérios a incluir (separado do bloco “sugeridas”)
    // 4.3.12 — campos explícitos (pedido do usuário)
    F4312_INCLUIR: zArrStr,        // (a) Critérios do extrato que precisará incluir em Plano de Ação
    F4312_JUST: zStr,              // (b) Justificativas/informações relativas à solicitação de inclusão
    F4312_DESC_PLANOS: zStr,       // (c) Descrever sucintamente o(s) Plano(s) de Ação apresentado(s)

    // 4.4
    F44_CRITERIOS: zArrStr,        // lista 1..22 (labels livres)
    F44_DECLS: zArrStr,
    F44_FINALIDADES: zArrStr,
    F44_ANEXOS: zStr,
    F441_LEGISLACAO: zStr,         // 4.4.1(d) – legislação
    F445_DESC_PLANOS: zStr,        // 4.4.5 – descrição dos planos
    F446_DOCS: zStr,               // 4.4.6(a)
    F446_EXEC_RES: zStr,           // 4.4.6(b)

    // 4.5
    F45_OK451: z.boolean().optional().default(false),
    F45_DOCS: zStr,
    F45_JUST: zStr,
    F453_EXEC_RES: zStr,

    // 4.6
    F46_CRITERIOS: zArrStr,        // 4.6.1 – critérios regulares (não objeto dos planos)
    F46_PROGESTAO: zStr,           // 4.6.1(b) – nível Pró-Gestão
    F46_PORTE: zStr,               // 4.6.1(c) – Porte ISP-RPPS
    F46_JUST_D: zStr,              // 4.6.1(d) – justificativas (melhora situação)
    F46_DOCS_D: zStr,              // 4.6.1(d) – documentos
    F46_JUST_E: zStr,              // 4.6.1(e) – justificativas
    F46_DOCS_E: zStr,              // 4.6.1(e) – documentos
    F46_FINALIDADES: zArrStr,      // 4.6.2 – finalidades
    F46_ANEXOS: zStr,
    F46_JUST_PLANOS: zStr,         // 4.6.5
    F46_COMP_CUMPR: zStr,          // 4.6.6 (a/b) – texto consolidado/espelho
    F462F_CRITERIOS: zArrStr,      // 4.6.2(f) – “critérios estruturantes/complexidade”
    F466_DOCS: zStr,               // 4.6.6(a)
    F466_EXEC_RES: zStr,           // 4.6.6(b)

    // 5) Justificativas gerais
    JUSTIFICATIVAS_GERAIS: zStr,

    // Carimbos
    MES: z.string().min(1),
    DATA_SOLIC_GERADA: z.string().min(1),
    HORA_SOLIC_GERADA: z.string().min(1),
    ANO_SOLIC_GERADA: z.string().min(4),

    // Idempotência
    IDEMP_KEY: z.string().optional().default(""),

    /* === [PATCH] Compat: aceitar todos os campos detalhados do Item 4 (nomes "fase4_*") ===
       Esses campos são “espelho” do seu formulário granular, e alimentam o HTML
       via bloco “fase-extra-campos”. Mantidos **sem** validação rígida de conteúdo. */

    // 4.1
    fase4_1_criterios: zArrStr,
    fase4_1_criterios_outros: zStr,
    fase4_1_declaracao_base: zStr,
    fase4_1_decl_a_data: zStr,
    fase4_1_decl_b_conf: zArrStr,
    fase4_1_decl_f: zArrStr,
    fase4_1_finalidade: zArrStr,
    fase4_1_finalidade_protocolos: zArrStr,
    fase4_1_anexos: zArrStr,
    fase4_1_anexos_desc: zArrStr,
    fase4_1_just: zStr,
    fase4_1_comp_tipo: zStr,
    fase4_1_comp_protocolo: zStr,
    fase4_1_comp_data: zStr,

    // 4.2
    fase4_2_criterios: zArrStr,
    fase4_2_decl: zStr,
    fase4_2_decl_a_lei: zStr,
    fase4_2_decl_b_prazo: zStr,
    fase4_2_decl_f: zArrStr,
    fase4_2_finalidade: zStr,
    fase4_2_prazo_req: zStr,
    fase4_2_prazo_fund: zStr,
    fase4_2_anexos: zArrStr,
    fase4_2_anexos_desc: zArrStr,
    fase4_2_just: zStr,
    fase4_2_comp_tipo: zStr,
    fase4_2_comp_num: zStr,
    fase4_2_comp_data: zStr,

    // 4.3
    fase4_3_escopo: zArrStr,
    fase4_3_eq_massa_alvo: zArrStr,
    fase4_3_eq_crono: zStr,
    fase4_3_eq_indicadores: zArrStr,
    fase4_3_eq_indicadores_outros: zStr,
    fase4_3_decl: zStr,
    fase4_3_decl_a_param: zStr,
    fase4_3_decl_f: zArrStr,
    fase4_3_finalidade: zArrStr,
    fase4_3_alt_detalhe: zStr,
    fase4_3_anexos: zArrStr,
    fase4_3_anexos_desc: zArrStr,
    fase4_3_just: zStr,
    fase4_3_comp_tipo: zStr,
    fase4_3_comp_num: zStr,
    fase4_3_comp_data: zStr,

    // 4.4
    fase4_4_debitos_massa: zArrStr,
    fase4_4_debitos_outros: zStr,
    fase4_4_vinc_fpm: zStr,
    fase4_4_vinc_lei: zStr,
    fase4_4_vinc_proc: zStr,
    fase4_4_comp_tipo: zStr,
    fase4_4_comp_dipr_num: zStr,
    fase4_4_comp_dipr_data: zStr,
    fase4_4_anexos: zArrStr,
    fase4_4_anexos_desc: zArrStr,
    fase4_4_just: zStr,
    fase4_4_comp_final_tipo: zStr,
    fase4_4_comp_final_num: zStr,
    fase4_4_comp_final_data: zStr,

    // 4.5
    fase4_5_criterios: zArrStr,
    fase4_5_decl: zStr,
    fase4_5_decl_a_dtcrp_ult: zStr,
    fase4_5_decl_b_tipo: zStr,
    fase4_5_decl_f: zArrStr,
    fase4_5_finalidade: zArrStr,
    fase4_5_crp_info: zStr,
    fase4_5_anexos: zArrStr,
    fase4_5_anexos_desc: zArrStr,
    fase4_5_just: zStr,
    fase4_5_comp_tipo: zStr,
    fase4_5_comp_num: zStr,
    fase4_5_comp_data: zStr,

    // 4.6
    fase4_6_criterios_plano: zArrStr,
    fase4_6_pg_nivel: zStr,
    fase4_6_criterios_outros: zStr,
    fase4_6_declaracoes: zStr,
    fase4_6_decl_a_base: zStr,
    fase4_6_decl_b_conferencia: zArrStr,
    fase4_6_crit_f: zArrStr,
    fase4_6_finalidade: zArrStr,
    fase4_6_alt_crono: zStr,
    fase4_6_alt_kpi: zArrStr,
    fase4_6_prazo_data: zStr,
    fase4_6_prazo_fund: zStr,
    fase4_6_anexos: zArrStr,
    fase4_6_anexos_desc: zArrStr,
    fase4_6_anexos_tipo: zStr,
    fase4_6_anexos_ref: zStr,
    fase4_6_just: zStr,
    fase4_6_comp: zStr,
    fase4_6_comp_kpi: zArrStr,
    fase4_6_comp_kpi_arq: zArrStr,
    fase4_6_comp_num: zStr,
    fase4_6_comp_data: zStr,
  })
  .superRefine((data, ctx) => {
    const fase = data.FASE_PROGRAMA;

    // 4.1
    if (fase === "4.1") {
      if (!data.F41_OPCAO?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["F41_OPCAO"],
          message: "Na fase 4.1, selecione 4.1.1 ou 4.1.2.",
        });
      }
    }

    // 4.2
    if (fase === "4.2") {
      if (!data.F42_LISTA || data.F42_LISTA.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["F42_LISTA"],
          message: "Na fase 4.2, marque ao menos um item (a–i).",
        });
      }
    }

    // 4.3 — precisa haver algo preenchido
    if (fase === "4.3") {
      const algoPreenchido =
        (data.F43_LISTA && data.F43_LISTA.length > 0) ||
        (data.F43_PLANO && data.F43_PLANO.trim() !== "") ||
        (data.F43_PLANO_B && data.F43_PLANO_B.trim() !== "") ||
        (data.F43_DESC_PLANOS && data.F43_DESC_PLANOS.trim() !== "") ||
        (data.F43_INCLUIR && data.F43_INCLUIR.length > 0) ||
        (data.F4312_INCLUIR && data.F4312_INCLUIR.length > 0) ||
        (data.F4312_JUST && data.F4312_JUST.trim() !== "") ||
        (data.F4312_DESC_PLANOS && data.F4312_DESC_PLANOS.trim() !== "") ||
        (data.F43_JUST && data.F43_JUST.trim() !== "");

      if (!algoPreenchido) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["F43_LISTA"],
          message:
            "Na fase 4.3, marque ao menos um critério ou descreva/justifique no(s) campo(s) disponível(is).",
        });
      }

      // 4.3.10 — se selecionar A ou B, exigir pelo menos legislação (A) ou docs (B)
      const opt4310 = (data.F4310_OPCAO || "").trim().toUpperCase(); // "A" | "B" | ""
      if (opt4310 === "A" && !(data.F4310_LEGISLACAO || "").trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["F4310_LEGISLACAO"],
          message:
            "Em 4.3.10 (A), relacione a legislação de adequação às regras da EC 103/2019.",
        });
      }
      if (opt4310 === "B" && !(data.F4310_DOCS || "").trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["F4310_DOCS"],
          message:
            "Em 4.3.10 (B), informe os documentos/encaminhamentos comprobatórios.",
        });
      }
    }

    // 4.4 — finalidade “e” exige ao menos um critério selecionado
    if (fase === "4.4") {
      const finalidadeE = (data.F44_FINALIDADES || []).some((f) =>
        /Organização do RPPS.*critério estruturante/i.test(f)
      );
      if (finalidadeE && (!data.F44_CRITERIOS || data.F44_CRITERIOS.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["F44_CRITERIOS"],
          message:
            "Na 4.4, ao marcar a finalidade “e)”, selecione pelo menos um critério em 4.4.3.",
        });
      }
    }

    // 4.5 — ao menos um bloco
    if (fase === "4.5") {
      const algum =
        !!data.F45_OK451 ||
        (data.F45_DOCS && data.F45_DOCS.trim() !== "") ||
        (data.F45_JUST && data.F45_JUST.trim() !== "") ||
        (data.F453_EXEC_RES && data.F453_EXEC_RES.trim() !== "");
      if (!algum) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["F45_OK451"],
          message:
            "Na fase 4.5, marque 4.5.1 ou preencha documentos/justificativas/execução.",
        });
      }
    }

    // 4.6 — mínimos obrigatórios
    if (fase === "4.6") {
      if (!data.F46_CRITERIOS || data.F46_CRITERIOS.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["F46_CRITERIOS"],
          message: "Na fase 4.6, selecione ao menos um critério em 4.6.1.",
        });
      }
      if (!data.F46_PROGESTAO?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["F46_PROGESTAO"],
          message: "Informe o nível Pró-Gestão em 4.6.1 (b).",
        });
      }
      if (!data.F46_PORTE?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["F46_PORTE"],
          message: "Informe o Porte ISP-RPPS em 4.6.1 (c).",
        });
      }
    }
  });
/* ==========================================================
   Observações de compatibilidade com o template PDF (HTML):

   - Os campos usados no termo_solic_crp.html estão TODOS refletidos
     aqui (F44_*, F46_*, F462F_CRITERIOS, F446_DOCS/EXEC_RES, etc.).
   - Adicionados explicitamente os itens da **4.3.12**:
       • F4312_INCLUIR (a)
       • F4312_JUST (b)
       • F4312_DESC_PLANOS (c)
     Esses três campos serão consumidos no front e podem ser exibidos
     no bloco "fase-extra-campos" (prefixos fase4_3_* ou via binding direto).

   - Arrays aceitam string única separada por “; , ou quebra de linha”
     graças ao zArrStr (robusto para payloads vindos do form).

   - “Não informado” no PDF:
     o HTML já controla via __NA_ALL__/__NA_LABEL__; aqui garantimos que
     valores faltantes virem "" ou [] sem quebrar a renderização.

   - PRAZO_ADICIONAL_COD/TEXTO são mantidos para o 3.4,
     que o template resolve via <div data-3_4="3.4.x">.

   Qualquer divergência de labels não impede a geração:
   as listas aceitam strings livres, mas exportamos F42_OPCOES e CRITERIOS_1_22
   para padronizar as escolhas no front.
========================================================== */
