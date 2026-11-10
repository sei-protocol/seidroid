{{- define "seidroid.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "seidroid.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else if contains (include "seidroid.name" .) .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "seidroid.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "seidroid.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "seidroid.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "seidroid.selectorLabels" -}}
app.kubernetes.io/name: {{ include "seidroid.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "seidroid.labels" -}}
{{ include "seidroid.selectorLabels" . }}
app.kubernetes.io/version: {{ include "seidroid.imageTag" . | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "seidroid.imageTag" -}}
{{- .Values.image.tag | default .Chart.AppVersion }}
{{- end }}

{{/*
The image at its tag. A published chart's own image, used when no tag is set,
is also pinned to the digest it was built with.
*/}}
{{- define "seidroid.image" -}}
{{- $digest := .Values.image.digest }}
{{- if and (not .Values.image.tag) .Chart.Annotations }}
{{- $digest = $digest | default (index .Chart.Annotations "sei.io/image-digest") }}
{{- end }}
{{- .Values.image.repository }}:{{ include "seidroid.imageTag" . }}{{ with $digest }}@{{ . }}{{ end }}
{{- end }}
