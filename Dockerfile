FROM mcr.microsoft.com/dotnet/sdk:3.1-alpine AS build-env

WORKDIR /app/stage

# Copy csproj and restore as distinct layers
COPY . .

RUN dotnet restore
RUN dotnet publish -c Release -o out

# Build runtime image
FROM mcr.microsoft.com/dotnet/aspnet:3.1-alpine

WORKDIR /app/build
COPY --from=build-env "/app/stage/out" .
ENTRYPOINT ["dotnet", "API.dll"]