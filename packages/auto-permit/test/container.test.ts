/**
 * Container-boundary pins. `containerRisk` decides which container shapes
 * never reach the judge model (they go straight to the human dialog), and
 * `isMutableFileDependent` decides which commands the exact-repeat memory
 * must re-judge. Both are conservative token heuristics, so every test also
 * pins the benign side that must stay auto-approvable.
 *
 * @module dsh-auto-permit/container.test
 */
import { describe, expect, it } from 'vitest'
import { containerRisk, isMutableFileDependent, CONTAINER_RISKS } from '../src/container.js'
import { isHighRisk } from '../src/rules.js'

describe('compose and remote targets', () => {
  it('routes compose invocations to the human (resolved effects are invisible)', () => {
    for (const command of [
      'podman compose up -d',
      'podman compose down',
      'docker compose up --build',
      'podman-compose up',
      'docker-compose up -d',
      '"/usr/local/bin/docker" compose up',
      'podman kube play pod.yaml',
      'podman kube down pod.yaml',
      'podman play kube pod.yaml',
    ]) {
      expect(containerRisk(command), command).toBe(CONTAINER_RISKS.compose)
    }
  })

  it('routes remote or unconfirmed engine targets to the human', () => {
    for (const command of [
      'podman --remote ps',
      'podman -c builder ps',
      'podman --url tcp://box:8080 ps',
      'podman --connection box build -t app .',
      'docker --context remote ps',
      'docker -H ssh://box ps',
      'podman-remote ps',
      'CONTAINER_HOST=ssh://box podman ps',
      'DOCKER_HOST=tcp://box:2376 docker ps',
    ]) {
      expect(containerRisk(command), command).toBe(CONTAINER_RISKS.remote)
    }
  })
})

describe('privilege, namespaces, and sockets', () => {
  it('routes privilege and device shapes to the human', () => {
    for (const command of [
      'podman run --privileged alpine',
      'podman run --device /dev/kvm alpine',
      'podman run --cap-add NET_ADMIN alpine',
      'podman build --ssh default .',
      'podman run --security-opt seccomp=unconfined alpine',
      'podman run --security-opt label=disable alpine',
      '/usr/bin/podman run --privileged alpine',
      'podman run "--privileged" alpine',
      'bash -c "podman run --privileged alpine"',
    ]) {
      expect(containerRisk(command), command).toBe(CONTAINER_RISKS.privilege)
    }
  })

  it('routes host namespaces to the human but keeps --network none/local', () => {
    for (const command of [
      'podman run --network host alpine',
      'podman run --net=host alpine',
      'podman run --pid=host alpine',
      'podman run --ipc host alpine',
      'podman run --userns=host alpine',
      'podman run --cgroupns=host alpine',
      'podman run --network "host" alpine',
      'podman run --network=host,slirp4netns alpine',
      'docker run --network container:db alpine',
    ]) {
      expect(containerRisk(command), command).toBe(CONTAINER_RISKS.namespace)
    }
    expect(containerRisk('podman run --network=none alpine')).toBeUndefined()
    expect(containerRisk('podman run --network=slirp4netns alpine')).toBeUndefined()
    expect(containerRisk('podman build --network=none -t app .')).toBeUndefined()
  })

  it('routes any engine-socket reference to the human', () => {
    for (const command of [
      'curl --unix-socket /run/podman/podman.sock http://d/v4.0.0/libpod/info',
      'podman run -v /run/podman/podman.sock:/sock alpine',
      'podman run -v /var/run/docker.sock:/var/run/docker.sock alpine',
    ]) {
      expect(containerRisk(command), command).toBe(CONTAINER_RISKS.socket)
    }
  })
})

describe('sensitive mounts', () => {
  it('routes home, root, credential, and config mounts to the human', () => {
    for (const command of [
      'podman run -v /:/host alpine',
      'podman run -v $HOME:/host alpine',
      'podman run -v ${HOME}/.ssh:/keys alpine',
      'podman run -v ~/.ssh:/keys alpine',
      'podman run -v /root:/host alpine',
      'podman run --mount type=bind,source=/root,target=/host alpine',
      'podman run -v /dev:/dev alpine',
      'podman run -v /proc:/host/proc alpine',
      'podman run -v /sys/fs/cgroup:/sys/fs/cgroup alpine',
      'podman run --volume=/home/u/.aws:/aws alpine',
      'podman run -v /home/u/.gnupg:/keys alpine',
      'podman run -v /home/u:/host alpine',
      'podman run -v /home/u/:/host alpine',
      'podman run -v/home/u/:/host alpine',
      'podman run -v //home/u:/host alpine',
      'podman run -v /home//u:/host alpine',
      'podman run -v/:/host alpine',
      'podman run -v/home/u/.ssh:/keys alpine',
      'podman run -v/root:/host alpine',
      'podman run -itv/:/host alpine',
      'podman run -itv /home/u/.ssh:/keys alpine',
      'podman run --volume=/home/u/:/host alpine',
      'podman run -v /home/u/./:/host alpine',
      'podman run -v /home/u/../u:/host alpine',
      'podman run --mount type=bind,source=/home/u/,target=/host alpine',
      'podman run -v /run/user/1000:/run alpine',
      'podman run -v "$HOME":/host alpine',
      'podman run -v "$HOME/":/host alpine',
      'podman run --volumes-from other-container alpine',
      'podman run --env-file $HOME/.env alpine',
      'podman build --secret id=key,src=/root/key .',
      'podman run -v /home/u/.config:/c alpine',
      'podman run -v /home/u/.local/share/containers:/c alpine',
    ]) {
      expect(containerRisk(command), command).toBe(CONTAINER_RISKS.mount)
    }
  })

  it('keeps project bind mounts auto-approvable', () => {
    for (const command of [
      'podman run --rm -v "$PWD":/src -w /src local/app:test cargo test',
      'podman run --rm --volume=/home/u/Projects/app:/src local/app:test make test',
      'podman run --rm --volume=/home/u/Projects/app/:/src local/app:test make test',
      'podman run --rm -v/home/u/Projects/app:/src local/app:test make test',
      'podman run --rm -v //home/u/Projects/app:/src local/app:test make test',
      'podman run --rm --mount type=bind,source=/home/u/Projects/app,target=/src local/app:test make test',
      'podman run --rm -v /tmp/app-cache:/cache local/app:test make test',
    ]) {
      expect(containerRisk(command), command).toBeUndefined()
    }
  })
})

describe('existing-resource lifecycle, prune, push, host configuration', () => {
  it('routes lifecycle operations on existing containers to the human', () => {
    for (const command of [
      'podman exec app make test',
      'podman stop app',
      'podman kill app',
      'podman rm app',
      'podman restart app',
      'podman start app',
      'podman pause app',
      'podman cp app:/out ./out',
      'podman commit app local/app:snapshot',
      'podman container rm app',
      'podman pod rm task-pod',
    ]) {
      expect(containerRisk(command), command).toBe(CONTAINER_RISKS.lifecycle)
    }
  })

  it('keeps disposable run/build invocations out of the lifecycle shape', () => {
    for (const command of [
      'podman run --rm local/app:test npm start',
      'podman run --rm --name task-box local/app:test make test',
      'podman build -t local/app:test .',
      'podman run -d --rm local/app:test serve',
    ]) {
      expect(containerRisk(command), command).toBeUndefined()
    }
  })

  it('routes volume and global prune/reset to the human', () => {
    for (const command of [
      'podman volume rm app-data',
      'podman volume prune -f',
      'podman system prune -af',
      'podman system reset',
      'podman image prune -a',
      'podman container prune -f',
      'docker network prune -f',
    ]) {
      expect(containerRisk(command), command).toBe(CONTAINER_RISKS.prune)
    }
  })

  it('routes host engine configuration to the human', () => {
    for (const command of [
      'podman system service --time=0',
      'podman system connection add box ssh://box',
      'podman machine init',
      'podman machine rm',
      'podman generate systemd app',
      'podman --hooks-dir /tmp/hooks run alpine',
      'podman push local/app:test registry.example/app:test',
      'docker push registry.example/app:test',
    ]) {
      const risk = containerRisk(command)
      expect(risk, command).toBe(
        command.includes('push') ? CONTAINER_RISKS.push : CONTAINER_RISKS.hostConfig,
      )
    }
  })
})

describe('grouped subcommands classify like their flat aliases', () => {
  it('routes grouped lifecycle, push, and prune forms to the human', () => {
    const cases: [string, string][] = [
      ['podman container exec production-db sh -c id', CONTAINER_RISKS.lifecycle],
      ['podman container stop production-db', CONTAINER_RISKS.lifecycle],
      ['podman container rm production-db', CONTAINER_RISKS.lifecycle],
      ['podman container cp production-db:/out ./out', CONTAINER_RISKS.lifecycle],
      ['podman container commit production-db app:snap', CONTAINER_RISKS.lifecycle],
      ['podman container prune -f', CONTAINER_RISKS.prune],
      ['podman pod kill task-pod', CONTAINER_RISKS.lifecycle],
      ['podman pod rm task-pod', CONTAINER_RISKS.lifecycle],
      ['podman pod prune', CONTAINER_RISKS.prune],
      ['podman image push app registry.example/app', CONTAINER_RISKS.push],
      ['podman manifest push app docker://registry.example/app', CONTAINER_RISKS.push],
      ['podman artifact push app oci-archive:app.tar', CONTAINER_RISKS.push],
      ['podman image rm app', CONTAINER_RISKS.lifecycle],
      ['podman image prune -a', CONTAINER_RISKS.prune],
      ['podman volume rm app-data', CONTAINER_RISKS.prune],
      ['podman network rm app-net', CONTAINER_RISKS.lifecycle],
      ['podman network prune -f', CONTAINER_RISKS.prune],
      ['podman secret rm app-secret', CONTAINER_RISKS.lifecycle],
      ['podman manifest remove app', CONTAINER_RISKS.lifecycle],
      ['docker container exec db sh', CONTAINER_RISKS.lifecycle],
      ['docker node rm node1', CONTAINER_RISKS.lifecycle],
      ['docker service rm svc', CONTAINER_RISKS.lifecycle],
      ['docker stack rm stack', CONTAINER_RISKS.lifecycle],
      ['docker plugin rm plugin', CONTAINER_RISKS.lifecycle],
      ['docker context rm remote', CONTAINER_RISKS.lifecycle],
      ['docker builder prune -f', CONTAINER_RISKS.prune],
      ['docker buildx prune -f', CONTAINER_RISKS.prune],
      ['docker swarm init', CONTAINER_RISKS.hostConfig],
    ]
    for (const [command, risk] of cases) {
      expect(containerRisk(command), command).toBe(risk)
      expect(isHighRisk(command), command).toBe(true)
    }
  })

  it('keeps grouped read-only and create forms for the judge', () => {
    for (const command of [
      'podman container ps -a',
      'podman container logs app',
      'podman container inspect app',
      'podman image ls',
      'podman image inspect app',
      'podman image pull alpine',
      'podman pod ps',
      'podman pod inspect task-pod',
      'podman network ls',
      'podman volume ls',
      'podman volume inspect app-data',
      'podman manifest inspect app',
      'podman secret ls',
      'docker node ls',
      'docker service ls',
      'docker buildx ls',
      'docker builder du',
    ]) {
      expect(containerRisk(command), command).toBeUndefined()
    }
  })
})

describe('benign container calls stay for the judge', () => {
  it('classifies read-only and disposable build/test invocations as no hard risk', () => {
    for (const command of [
      'podman ps -a',
      'podman images',
      'podman logs app',
      'podman inspect app',
      'podman version',
      'podman info',
      'podman pull alpine:3.20',
      'podman build -f Containerfile -t local/app:test .',
      'podman run --rm local/app:test make test',
      'podman run --rm -p 8080:80 local/app:test serve',
      'mkdir -p out && podman build -t local/app:test . && podman run --rm local/app:test make test',
    ]) {
      expect(containerRisk(command), command).toBeUndefined()
    }
  })

  it('ignores commands that only mention an engine without invoking it', () => {
    expect(containerRisk('echo "podman is installed"')).toBeUndefined()
    expect(containerRisk('rg podman README.md')).toBeUndefined()
    expect(containerRisk('uv sync')).toBeUndefined()
  })

  it('scans every segment of a compound input, not only the first', () => {
    expect(containerRisk('mkdir -p out && podman run --privileged alpine'))
      .toBe(CONTAINER_RISKS.privilege)
    expect(containerRisk('podman build -t app . && podman push app'))
      .toBe(CONTAINER_RISKS.push)
    expect(containerRisk('echo hi | podman run -v /:/host alpine'))
      .toBe(CONTAINER_RISKS.mount)
    expect(containerRisk('podman ps; podman system prune -af'))
      .toBe(CONTAINER_RISKS.prune)
  })

  it('folds the container boundary into the shared high-risk oracle', () => {
    expect(isHighRisk('podman run --privileged alpine')).toBe(true)
    expect(isHighRisk('podman run --rm local/app:test make test')).toBe(false)
    expect(isHighRisk('sudo podman ps')).toBe(true)
  })
})

describe('mutable-file dependence (exact-repeat memory must re-judge)', () => {
  it('treats every container-engine invocation as mutable-file dependent', () => {
    for (const command of [
      'podman build -t app .',
      'podman ps',
      'podman compose up -d',
      'docker build -t app .',
    ]) {
      expect(isMutableFileDependent(command), command).toBe(true)
    }
  })

  it('treats shell-script execution as mutable-file dependent', () => {
    for (const command of [
      './scripts/test-container.sh',
      'bash scripts/verify.sh --fast',
      'sh ./ci/check.bash',
      'source ./env/setup.sh',
      '. ./bin/test.sh',
    ]) {
      expect(isMutableFileDependent(command), command).toBe(true)
    }
  })

  it('keeps plain toolchain commands replayable', () => {
    for (const command of [
      'uv sync',
      'cargo build --release',
      'pnpm test',
      'git status',
    ]) {
      expect(isMutableFileDependent(command), command).toBe(false)
    }
  })
})
