import {
  BedrockImageGenerationResponse,
  GenerateImageParams,
  Model,
  PromptTemplate,
  StableDiffusionParams,
  TitanImageParams,
  UnrecordedMessage,
  ConverseInferenceParams,
  UsecaseConverseInferenceParams,
  GuardrailConverseConfigParams,
  GuardrailConverseStreamConfigParams,
} from 'generative-ai-use-cases-jp';
import {
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommandInput,
  ConverseStreamOutput,
  ConversationRole,
  ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

// Default Models

const modelId: string = JSON.parse(process.env.MODEL_IDS!)
  .map((name: string) => name.trim())
  .filter((name: string) => name)[0]!;
export const defaultModel: Model = {
  type: 'bedrock',
  modelId: modelId,
};

const imageGenerationModelId: string = JSON.parse(
  process.env.IMAGE_GENERATION_MODEL_IDS!
)
  .map((name: string) => name.trim())
  .filter((name: string) => name)[0]!;
export const defaultImageGenerationModel: Model = {
  type: 'bedrock',
  modelId: imageGenerationModelId,
};

// Prompt Templates

const LLAMA2_PROMPT: PromptTemplate = {
  prefix: '<s>[INST] ',
  suffix: ' [/INST]',
  join: '',
  user: '{}',
  assistant: ' [/INST] {}</s><s>[INST] ',
  system: '<<SYS>>\n{}\n<</SYS>>\n\n',
  eosToken: '</s>',
};

// Jambaではプロンプトの前処理にPromptTemplateを使用していないが、
// BEDROCK_MODELSで指定が必要なためダミーで作成しています
const JAMBA_PROMPT: PromptTemplate = {
  prefix: '',
  suffix: '',
  join: '',
  user: '',
  assistant: '',
  system: '',
  eosToken: '',
};

const BILINGUAL_RINNA_PROMPT: PromptTemplate = {
  prefix: '',
  suffix: 'システム: ',
  join: '\n',
  user: 'ユーザー: {}',
  assistant: 'システム: {}',
  system: 'システム: {}',
  eosToken: '</s>',
};

const RINNA_PROMPT: PromptTemplate = {
  prefix: '',
  suffix: 'システム: ',
  join: '<NL>',
  user: 'ユーザー: {}',
  assistant: 'システム: {}',
  system: 'システム: {}',
  eosToken: '</s>',
};

// Model Params

const CLAUDE_DEFAULT_PARAMS: ConverseInferenceParams = {
  maxTokens: 4096,
  temperature: 0.6,
  topP: 0.8,
};

const TITAN_TEXT_DEFAULT_PARAMS: ConverseInferenceParams = {
  maxTokens: 3072,
  temperature: 0.7,
  topP: 1.0,
};

const LLAMA_DEFAULT_PARAMS: ConverseInferenceParams = {
  maxTokens: 2048,
  temperature: 0.6,
  topP: 0.99,
};

const MISTRAL_DEFAULT_PARAMS: ConverseInferenceParams = {
  maxTokens: 8192,
  temperature: 0.6,
  topP: 0.99,
};

const MIXTRAL_DEFAULT_PARAMS: ConverseInferenceParams = {
  maxTokens: 4096,
  temperature: 0.6,
  topP: 0.99,
};

const COMMANDR_DEFAULT_PARAMS: ConverseInferenceParams = {
  maxTokens: 4000,
  temperature: 0.3,
  topP: 0.75,
};

const USECASE_DEFAULT_PARAMS: UsecaseConverseInferenceParams = {
  '/rag': {
    temperature: 0.0,
  },
};

const JAMBA_DEFAULT_PARAMS: ConverseInferenceParams = {
  max_tokens: 4096,
  temperature: 0.3,
  top_p: 0.999,
  n: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
  stop: [],
};

// guardrail 設定
const createGuardrailConfig = (): GuardrailConverseConfigParams | undefined => {
  if (
    process.env.GUARDRAIL_IDENTIFIER !== undefined &&
    process.env.GUARDRAIL_VERSION !== undefined
  ) {
    return {
      guardrailIdentifier: process.env.GUARDRAIL_IDENTIFIER,
      guardrailVersion: process.env.GUARDRAIL_VERSION,
      // 出力が重くなる&現状トレースを確認する手段がアプリ側に無いので disabled をハードコーディング
      trace: 'disabled',
    };
  }
  return undefined;
};

const createGuardrailStreamConfig = ():
  | GuardrailConverseStreamConfigParams
  | undefined => {
  const baseConfig = createGuardrailConfig();
  if (baseConfig) {
    return {
      ...baseConfig,
      // 非同期だとマズい出力が出る可能性があるが、まずい入力をしない限り出力が出たことがない（＝入力時点でストップ）ので、
      // 非同期で体験を良くすることとする
      // https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-streaming.html
      streamProcessingMode: 'async',
    };
  }
  return undefined;
};

// ID変換ルール
const idTransformationRules = [
  // チャット履歴 -> チャット
  { pattern: /^\/chat\/.+/, replacement: '/chat' },
];

// ID変換
function normalizeId(id: string): string {
  if (!id) return id;
  const rule = idTransformationRules.find((rule) => id.match(rule.pattern));
  const ret = rule ? rule.replacement : id;
  return ret;
}

// API の呼び出しや、出力から文字列を抽出、などの処理

const createConverseCommandInput = (
  messages: UnrecordedMessage[],
  id: string,
  modelId: string,
  defaultConverseInferenceParams: ConverseInferenceParams,
  usecaseConverseInferenceParams: UsecaseConverseInferenceParams
) => {
  // system role で渡された文字列を、システムコンテキストに設定
  const system = messages.find((message) => message.role === 'system');
  const systemContext = system ? [{ text: system.content }] : [];

  // system role 以外の、user role と assistant role の文字列を conversation に入れる
  messages = messages.filter((message) => message.role !== 'system');
  const conversation = messages.map((message) => {
    const contentBlocks: ContentBlock[] = [
      { text: message.content } as ContentBlock.TextMember,
    ];

    if (message.extraData) {
      message.extraData.forEach((extra) => {
        if (extra.type === 'image' && extra.source.type === 'base64') {
          contentBlocks.push({
            image: {
              format: extra.source.mediaType.split('/')[1],
              source: {
                bytes: Buffer.from(extra.source.data, 'base64'),
              },
            },
          } as ContentBlock.ImageMember);
        } else if (extra.type === 'file' && extra.source.type === 'base64') {
          contentBlocks.push({
            document: {
              format: extra.name.split('.').pop(),
              name: extra.name
                .split('.')[0]
                .replace(/[^a-zA-Z0-9\s\-()[\]]/g, 'X'), // ファイル名に日本語などが入っているとエラーになるため変換
              source: {
                bytes: Buffer.from(extra.source.data, 'base64'),
              },
            },
          } as ContentBlock.DocumentMember);
        }
      });
    }

    return {
      role:
        message.role === 'user'
          ? ConversationRole.USER
          : ConversationRole.ASSISTANT,
      content: contentBlocks,
    };
  });

  const usecaseParams = usecaseConverseInferenceParams[normalizeId(id)];
  const inferenceConfig = usecaseParams
    ? { ...defaultConverseInferenceParams, ...usecaseParams }
    : defaultConverseInferenceParams;

  const guardrailConfig = createGuardrailConfig();

  const converseCommandInput: ConverseCommandInput = {
    modelId: modelId,
    messages: conversation,
    system: systemContext,
    inferenceConfig: inferenceConfig,
    guardrailConfig: guardrailConfig,
  };

  return converseCommandInput;
};

// システムコンテキストに対応していないモデル用の関数
// - Amazon Titan モデル (amazon.titan-text-premier-v1:0)
// - Mistral AI Instruct (mistral.mixtral-8x7b-instruct-v0:1, mistral.mistral-7b-instruct-v0:2)
// https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html#conversation-inference-supported-models-features
const createConverseCommandInputWithoutSystemContext = (
  messages: UnrecordedMessage[],
  id: string,
  modelId: string,
  defaultConverseInferenceParams: ConverseInferenceParams,
  usecaseConverseInferenceParams: UsecaseConverseInferenceParams
) => {
  // system が利用できないので、system も user として入れる。
  messages = messages.filter((message) => message.role !== 'system');
  const conversation = messages.map((message) => ({
    role:
      message.role === 'user' || message.role === 'system'
        ? ConversationRole.USER
        : ConversationRole.ASSISTANT,
    content: [{ text: message.content }],
  }));

  const usecaseParams = usecaseConverseInferenceParams[normalizeId(id)];
  const inferenceConfig = usecaseParams
    ? { ...defaultConverseInferenceParams, ...usecaseParams }
    : defaultConverseInferenceParams;

  const guardrailConfig = createGuardrailConfig();

  const converseCommandInput: ConverseCommandInput = {
    modelId: modelId,
    messages: conversation,
    inferenceConfig: inferenceConfig,
    guardrailConfig: guardrailConfig,
  };

  return converseCommandInput;
};

// ConverseStreamCommandInput は、同じ構造を持つため「createConverseCommandInput」で作成したインプットをそのまま利用する。
const createConverseStreamCommandInput = (
  messages: UnrecordedMessage[],
  id: string,
  modelId: string,
  defaultParams: ConverseInferenceParams,
  usecaseParams: UsecaseConverseInferenceParams
): ConverseStreamCommandInput => {
  const converseCommandInput = createConverseCommandInput(
    messages,
    id,
    modelId,
    defaultParams,
    usecaseParams
  );
  const guardrailStreamConfig = createGuardrailStreamConfig();
  return {
    ...converseCommandInput,
    guardrailStreamConfig,
  } as ConverseStreamCommandInput;
};

// システムコンテキストに対応していないモデル用の関数
// - Amazon Titan モデル (amazon.titan-text-premier-v1:0)
// - Mistral AI Instruct (mistral.mixtral-8x7b-instruct-v0:1, mistral.mistral-7b-instruct-v0:2)
// https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html#conversation-inference-supported-models-features
const createConverseStreamCommandInputWithoutSystemContext = (
  messages: UnrecordedMessage[],
  id: string,
  modelId: string,
  defaultParams: ConverseInferenceParams,
  usecaseParams: UsecaseConverseInferenceParams
): ConverseStreamCommandInput => {
  const converseCommandInput = createConverseCommandInputWithoutSystemContext(
    messages,
    id,
    modelId,
    defaultParams,
    usecaseParams
  );
  const guardrailStreamConfig = createGuardrailStreamConfig();
  return {
    ...converseCommandInput,
    guardrailStreamConfig,
  } as ConverseStreamCommandInput;
};

const extractConverseOutputText = (output: ConverseCommandOutput): string => {
  if (output.output && output.output.message && output.output.message.content) {
    // output.message.content は配列になっているが、基本的に要素は 1 個しか返ってこないため、join をする必要はない。
    // ただ、安全側に実装することを意識して、配列に複数の要素が来ても問題なく動作するように、join で改行を付けるよ実装にしておく。
    const responseText = output.output.message.content
      .map((block) => block.text)
      .join('\n');
    return responseText;
  }

  return '';
};

const extractConverseStreamOutputText = (
  output: ConverseStreamOutput
): string => {
  if (output.contentBlockDelta && output.contentBlockDelta.delta?.text) {
    return output.contentBlockDelta.delta?.text;
  }

  return '';
};


const createBodyImageStableDiffusion = (params: GenerateImageParams) => {
  let body: StableDiffusionParams = {
    text_prompts: params.textPrompt,
    cfg_scale: params.cfgScale,
    style_preset: params.stylePreset,
    seed: params.seed,
    steps: params.step,
    image_strength: params.maskImage ? 0 : params.imageStrength, // Inpaint/Outpaint 時に 0 以上だと悪さする
    height: params.height,
    width: params.width,
  };
  if (params.initImage && params.maskImage === undefined) {
    // Image to Image
    body = {
      ...body,
      init_image: params.initImage,
    };
  } else if (params.initImage && params.maskImage) {
    // Image to Image (Masking)
    body = {
      ...body,
      init_image: params.initImage,
      mask_image: params.maskImage,
      mask_source:
        params.maskMode === 'INPAINTING'
          ? 'MASK_IMAGE_BLACK'
          : 'MASK_IMAGE_WHITE',
    };
  }
  return JSON.stringify(body);
};

const createBodyImageTitanImage = (params: GenerateImageParams) => {
  // TODO: Support inpainting and outpainting too
  const imageGenerationConfig = {
    numberOfImages: 1,
    quality: 'standard',
    height: params.height,
    width: params.width,
    cfgScale: params.cfgScale,
    seed: params.seed % 214783648, // max for titan image
  };
  let body: Partial<TitanImageParams> = {};
  if (params.initImage && params.maskMode === undefined) {
    body = {
      taskType: 'IMAGE_VARIATION',
      imageVariationParams: {
        text:
          (params.textPrompt.find((x) => x.weight > 0)?.text || '') +
          ', ' +
          params.stylePreset,
        negativeText: params.textPrompt.find((x) => x.weight < 0)?.text,
        images: [params.initImage],
        similarityStrength: Math.max(params.imageStrength || 0.2, 0.2), // Min 0.2
      },
      imageGenerationConfig: imageGenerationConfig,
    };
  } else if (params.initImage && params.maskMode === 'INPAINTING') {
    body = {
      taskType: 'INPAINTING',
      inPaintingParams: {
        text:
          (params.textPrompt.find((x) => x.weight > 0)?.text || '') +
          ', ' +
          params.stylePreset,
        negativeText: params.textPrompt.find((x) => x.weight < 0)?.text,
        image: params.initImage,
        maskImage: params.maskImage,
        maskPrompt: params.maskPrompt,
      },
      imageGenerationConfig: imageGenerationConfig,
    };
  } else if (params.initImage && params.maskMode === 'OUTPAINTING') {
    body = {
      taskType: 'OUTPAINTING',
      outPaintingParams: {
        text:
          (params.textPrompt.find((x) => x.weight > 0)?.text || '') +
          ', ' +
          params.stylePreset,
        negativeText: params.textPrompt.find((x) => x.weight < 0)?.text,
        image: params.initImage,
        maskImage: params.maskImage,
        maskPrompt: params.maskPrompt,
        outPaintingMode: 'DEFAULT',
      },
      imageGenerationConfig: imageGenerationConfig,
    };
  } else {
    body = {
      taskType: 'TEXT_IMAGE',
      textToImageParams: {
        text:
          (params.textPrompt.find((x) => x.weight > 0)?.text || '') +
          ', ' +
          params.stylePreset,
        negativeText: params.textPrompt.find((x) => x.weight < 0)?.text || '',
      },
      imageGenerationConfig: imageGenerationConfig,
    };
  }
  return JSON.stringify(body);
};

const extractOutputImageStableDiffusion = (
  response: BedrockImageGenerationResponse
) => {
  if (response.result !== 'success') {
    throw new Error('Failed to invoke model');
  }
  return response.artifacts[0].base64;
};

const extractOutputImageTitanImage = (
  response: BedrockImageGenerationResponse
) => {
  return response.images[0];
};

// テキスト生成に関する、各のModel のパラメーターや関数の定義

export const BEDROCK_TEXT_GEN_MODELS: {
  [key: string]: {
    defaultParams: ConverseInferenceParams;
    usecaseParams: UsecaseConverseInferenceParams;
    createConverseCommandInput: (
      messages: UnrecordedMessage[],
      id: string,
      modelId: string,
      defaultParams: ConverseInferenceParams,
      usecaseParams: UsecaseConverseInferenceParams
    ) => ConverseCommandInput;
    createConverseStreamCommandInput: (
      messages: UnrecordedMessage[],
      id: string,
      modelId: string,
      defaultParams: ConverseInferenceParams,
      usecaseParams: UsecaseConverseInferenceParams
    ) => ConverseStreamCommandInput;
    extractConverseOutputText: (body: ConverseCommandOutput) => string;
    extractConverseStreamOutputText: (body: ConverseStreamOutput) => string;
  };
} = {
  'anthropic.claude-3-5-sonnet-20240620-v1:0': {
    defaultParams: CLAUDE_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'anthropic.claude-3-opus-20240229-v1:0': {
    defaultParams: CLAUDE_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'anthropic.claude-3-sonnet-20240229-v1:0': {
    defaultParams: CLAUDE_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'anthropic.claude-3-haiku-20240307-v1:0': {
    defaultParams: CLAUDE_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'anthropic.claude-v2:1': {
    defaultParams: CLAUDE_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'anthropic.claude-v2': {
    defaultParams: CLAUDE_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'anthropic.claude-instant-v1': {
    defaultParams: CLAUDE_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'amazon.titan-text-express-v1': {
    defaultParams: TITAN_TEXT_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInputWithoutSystemContext,
    createConverseStreamCommandInput:
      createConverseStreamCommandInputWithoutSystemContext,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'amazon.titan-text-premier-v1:0': {
    defaultParams: TITAN_TEXT_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInputWithoutSystemContext,
    createConverseStreamCommandInput:
      createConverseStreamCommandInputWithoutSystemContext,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'meta.llama3-8b-instruct-v1:0': {
    defaultParams: LLAMA_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'meta.llama3-70b-instruct-v1:0': {
    defaultParams: LLAMA_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'meta.llama3-1-8b-instruct-v1:0': {
    defaultParams: LLAMA_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'meta.llama3-1-70b-instruct-v1:0': {
    defaultParams: LLAMA_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'meta.llama3-1-405b-instruct-v1:0': {
    defaultParams: LLAMA_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'meta.llama2-13b-chat-v1': {
    defaultParams: LLAMA_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'meta.llama2-70b-chat-v1': {
    defaultParams: LLAMA_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'mistral.mistral-7b-instruct-v0:2': {
    defaultParams: MISTRAL_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInputWithoutSystemContext,
    createConverseStreamCommandInput:
      createConverseStreamCommandInputWithoutSystemContext,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'mistral.mixtral-8x7b-instruct-v0:1': {
    defaultParams: MIXTRAL_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInputWithoutSystemContext,
    createConverseStreamCommandInput:
      createConverseStreamCommandInputWithoutSystemContext,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'mistral.mistral-small-2402-v1:0': {
    defaultParams: MISTRAL_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'mistral.mistral-large-2402-v1:0': {
    defaultParams: MISTRAL_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'mistral.mistral-large-2407-v1:0': {
    defaultParams: MISTRAL_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'cohere.command-r-v1:0': {
    defaultParams: COMMANDR_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
  'cohere.command-r-plus-v1:0': {
    defaultParams: COMMANDR_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInput,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
    'ai21.j2-ultra-v1': {
    defaultParams: COMMANDR_DEFAULT_PARAMS,
    usecaseParams: USECASE_DEFAULT_PARAMS,
    createConverseCommandInput: createConverseCommandInput,
    createConverseStreamCommandInput: createConverseStreamCommandInputWithoutSystemContext,
    extractConverseOutputText: extractConverseOutputText,
    extractConverseStreamOutputText: extractConverseStreamOutputText,
  },
};

// 画像生成に関する、各のModel のパラメーターや関数の定義

export const BEDROCK_IMAGE_GEN_MODELS: {
  [key: string]: {
    createBodyImage: (params: GenerateImageParams) => string;
    extractOutputImage: (response: BedrockImageGenerationResponse) => string;
  };
} = {
  'stability.stable-diffusion-xl-v1': {
    createBodyImage: createBodyImageStableDiffusion,
    extractOutputImage: extractOutputImageStableDiffusion,
  },
  'amazon.titan-image-generator-v1': {
    createBodyImage: createBodyImageTitanImage,
    extractOutputImage: extractOutputImageTitanImage,
  },
  'amazon.titan-image-generator-v2:0': {
    createBodyImage: createBodyImageTitanImage,
    extractOutputImage: extractOutputImageTitanImage,
  },
};

export const getSageMakerModelTemplate = (model: string): PromptTemplate => {
  if (model.includes('llama-2')) {
    return LLAMA2_PROMPT;
  } else if (model.includes('bilingual-rinna')) {
    return BILINGUAL_RINNA_PROMPT;
  } else if (model.includes('rinna')) {
    return RINNA_PROMPT;
  }
  throw new Error('Invalid model name');
};
