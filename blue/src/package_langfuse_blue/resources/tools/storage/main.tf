terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.31.0" }
  }
}
provider "aws" { region = "<{ neon-r2-region }>" }
locals {
  buckets = {
    neon = "<{ neon-r2-bucket }>"
    data = "<{ langfuse-s3-bucket }>"
    backup = "<{ langfuse-backup-r2-bucket }>"
  }
  tags = { "colors:profile" = "<{ profile }>", "colors:owner" = "langfuse-storage" }
}
resource "aws_s3_bucket" "application" {
  for_each = local.buckets
  bucket = each.value
  force_destroy = true
  lifecycle { prevent_destroy = <{ compute-prevent-destroy }> }
  tags = local.tags
}
resource "aws_s3_bucket_public_access_block" "application" {
  for_each = aws_s3_bucket.application
  bucket = each.value.id
  block_public_acls = true
  block_public_policy = true
  ignore_public_acls = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "application" {
  for_each = aws_s3_bucket.application
  bucket = each.value.id
  # S3 now creates buckets with SSE-C blocked and the bucket key off; declare
  # both, or the provider plans to remove and re-add them on every converge.
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    blocked_encryption_types = ["SSE-C"]
    bucket_key_enabled = false
  }
}
# Browser uploads use signed URLs and must be allowed from the application origin.
resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.application["data"].id
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = ["https://<{ langfuse-host }>"]
    expose_headers = ["ETag"]
    max_age_seconds = 3600
  }
}
# Separate identities preserve the existing live-data/backup credential boundary.
resource "aws_iam_user" "application" {
  for_each = local.buckets
  name = "<{ profile }>-storage-${each.key}"
  tags = local.tags
}
resource "aws_iam_user_policy" "application" {
  for_each = aws_iam_user.application
  name = "langfuse-bucket"
  user = each.value.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"], Resource = [aws_s3_bucket.application[each.key].arn] },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], Resource = ["${aws_s3_bucket.application[each.key].arn}/*"] }
    ]
  })
}
resource "aws_iam_access_key" "application" {
  for_each = aws_iam_user.application
  user = each.value.name
  depends_on = [aws_iam_user_policy.application]
}
output "credentials" {
  value = { for role, key in aws_iam_access_key.application : role => { access_key_id = key.id, secret_access_key = key.secret } }
  sensitive = true
}
