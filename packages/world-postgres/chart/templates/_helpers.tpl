{{- define "workflow-postgres.name" -}}
{{- $name := required "serviceName is required" .Values.serviceName -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" $name) -}}{{- fail "serviceName must be a DNS label: at most 63 lowercase letters, digits and '-'" -}}{{- end -}}
{{- $name -}}
{{- end -}}

{{- define "workflow-postgres.jobPrefix" -}}
{{- if .Values.jobPrefix -}}
{{- .Values.jobPrefix -}}
{{- else -}}
{{- printf "%s_" (regexReplaceAll "[^a-z0-9]+" (lower .Values.serviceName) "_") -}}
{{- end -}}
{{- end -}}

{{/* The image tag, which is the deployment ID runs are pinned to. */}}
{{- define "workflow-postgres.tag" -}}
{{- $tag := required "image.tag is required: one immutable tag per build, such as the commit SHA" .Values.image.tag | toString -}}
{{- if gt (len $tag) 40 -}}{{- fail "image.tag must be at most 40 characters (a commit SHA)" -}}{{- end -}}
{{- if not (regexMatch "^[A-Za-z0-9._@-]+$" $tag) -}}{{- fail "image.tag may use only letters, digits, '.', '-', '_' and '@'" -}}{{- end -}}
{{- if eq $tag "postgres" -}}{{- fail "image.tag must not be 'postgres': it is reserved for unpinned runs" -}}{{- end -}}
{{- if gt (add (len (include "workflow-postgres.jobPrefix" .)) (len $tag) 1) 82 -}}{{- fail "jobPrefix and image.tag together must be at most 81 characters (Graphile Worker's 128 character names)" -}}{{- end -}}
{{- $tag -}}
{{- end -}}

{{/* <name>-wf-<tag>, within the 63 characters KEDA needs for the HPA label it derives. */}}
{{- define "workflow-postgres.workerName" -}}
{{- $name := include "workflow-postgres.name" . -}}
{{- $tag := include "workflow-postgres.tag" . -}}
{{- $budget := sub 59 (len $tag) | int -}}
{{- if le (len $name) $budget -}}
{{- printf "%s-wf-%s" $name $tag -}}
{{- else -}}
{{- printf "%s-%s-wf-%s" (trunc (sub $budget 7 | int) $name | trimSuffix "-") (sha256sum $name | trunc 6) $tag -}}
{{- end -}}
{{- end -}}

{{- define "workflow-postgres.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "workflow-postgres.name" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Read by `pruneWorkers`: keep in sync with WORKER_LABELS. */}}
{{- define "workflow-postgres.workerLabels" -}}
workflow.vercel.com/service: {{ include "workflow-postgres.name" . }}
workflow.vercel.com/role: worker
workflow.vercel.com/version: {{ include "workflow-postgres.tag" . | quote }}
{{- end -}}

{{- define "workflow-postgres.image" -}}
"{{ required "image.repository is required" .Values.image.repository }}:{{ include "workflow-postgres.tag" . }}"
{{- end -}}

{{/* The application container, less its name and env. */}}
{{- define "workflow-postgres.container" -}}
image: {{ include "workflow-postgres.image" . }}
imagePullPolicy: {{ .Values.image.pullPolicy }}
{{- with .Values.command }}
command: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.args }}
args: {{- toYaml . | nindent 2 }}
{{- end }}
ports:
  - name: http
    containerPort: {{ .Values.port }}
livenessProbe:
  httpGet: { path: {{ .Values.probes.livenessPath }}, port: http }
readinessProbe:
  httpGet: { path: {{ .Values.probes.readinessPath }}, port: http }
{{- with .Values.resources }}
resources: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.envFrom }}
envFrom: {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Env of every container: how @workflow/world-postgres's createWorld() reads its configuration. */}}
{{- define "workflow-postgres.baseEnv" -}}
- name: PORT
  value: {{ .Values.port | quote }}
- name: WORKFLOW_POSTGRES_JOB_PREFIX
  value: {{ include "workflow-postgres.jobPrefix" . | quote }}
{{- if .Values.versionPinning.enabled }}
- name: WORKFLOW_POSTGRES_DEPLOYMENT_ID
  value: {{ include "workflow-postgres.tag" . | quote }}
{{- end }}
{{- range $name, $value := .Values.env }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{- end -}}

{{- define "workflow-postgres.initContainers" -}}
{{- if .Values.migrations.enabled }}
{{- if not .Values.migrations.command }}{{- fail "migrations.command is required when migrations.enabled is true" }}{{- end }}
initContainers:
  - name: migrate
    image: {{ include "workflow-postgres.image" . }}
    imagePullPolicy: {{ .Values.image.pullPolicy }}
    command: {{- toYaml .Values.migrations.command | nindent 6 }}
    env:
      {{- include "workflow-postgres.baseEnv" . | nindent 6 }}
    {{- with .Values.envFrom }}
    envFrom: {{- toYaml . | nindent 6 }}
    {{- end }}
{{- end }}
{{- end -}}
